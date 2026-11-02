//! `get_weather` (docs/protocol.md, "Agent tools (v1)"; D-116): a forecast from
//! Open-Meteo for a place the model names, or for the session's place by IP once
//! the user approved it. The service gets a place name or rounded coordinates
//! from the server's address, never the user's IP.

use std::time::Duration;

use reqwest::{Url, header};
use serde_json::{Value, json};

use super::tools;
use crate::{auth::client::Located, providers::ProviderHttp};

/// The whole lookup, within what a turn's lease allows between renewals.
const TIME_MAX: Duration = Duration::from_secs(8);
/// The largest answer read.
const BODY_MAX: usize = 256 * 1024;
const PLACE_MAX: usize = 80;
pub const DAYS_MAX: u8 = 7;
/// Places the search returns, to choose by the part after a comma.
const MATCHES: &str = "5";
/// Open-Meteo's free data asks for this (CC BY 4.0).
const SOURCE: &str = "Open-Meteo.com, CC BY 4.0";

/// Where forecasts come from; `None` in the state turns the tool off.
#[derive(Clone, Debug)]
pub struct WeatherApi {
    pub geocoding: String,
    pub forecast: String,
}

impl WeatherApi {
    pub fn open_meteo() -> Self {
        Self {
            geocoding: "https://geocoding-api.open-meteo.com/v1/search".into(),
            forecast: "https://api.open-meteo.com/v1/forecast".into(),
        }
    }
}

/// A place's name as the tool takes it: letters and little else, so the field
/// cannot carry much besides a place to a third party. The text is the model's.
pub fn check_place(text: &str) -> Result<String, String> {
    let place = text.trim();
    if place.is_empty() || place.chars().count() > PLACE_MAX {
        return Err(format!("place must be a city's name of at most {PLACE_MAX} characters"));
    }
    if !place.chars().all(|c| c.is_alphabetic() || c.is_whitespace() || "-'’.,".contains(c)) {
        return Err("place must be only a city's name, optionally with its region or country after a comma".into());
    }
    Ok(place.to_owned())
}

async fn get(http: &ProviderHttp, url: Url) -> Result<Value, String> {
    let client = http.for_url(&url).map_err(|_| "the weather service is not reachable".to_owned())?;
    let sent = client.get(url).header(header::ACCEPT, "application/json").send();
    let response = sent.await.map_err(|_| "the weather service could not be reached; try again later".to_owned())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("the weather service answered with status {}; try again later", status.as_u16()));
    }
    let body = response.bytes().await.map_err(|_| "the weather service stopped answering".to_owned())?;
    if body.len() > BODY_MAX {
        return Err("the weather service's answer is too long".into());
    }
    serde_json::from_slice(&body).map_err(|_| "the weather service's answer could not be read".to_owned())
}

/// The best of the search's results: the part after a comma picks among them.
fn choose(found: &Value, place: &str) -> Option<(Located, Vec<String>)> {
    let results = found.get("results")?.as_array()?;
    let hint = place.split_once(',').map(|(_, rest)| rest.trim().to_lowercase());
    let named = |r: &Value, key: &str| r.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let matches = |r: &&Value| {
        hint.as_ref().is_none_or(|h| {
            ["country", "admin1", "admin2", "country_code"]
                .iter()
                .any(|k| named(r, k).to_lowercase().contains(h.as_str()))
        })
    };
    let best = results.iter().find(matches).or(results.first())?;
    let located = Located {
        name: named(best, "name"),
        country: named(best, "country"),
        latitude: best.get("latitude")?.as_f64()?,
        longitude: best.get("longitude")?.as_f64()?,
    };
    let others = results
        .iter()
        .filter(|r| !std::ptr::eq(*r, best))
        .take(2)
        .map(|r| format!("{}, {}", named(r, "name"), named(r, "country")))
        .collect();
    Some((located, others))
}

/// The tool's result from a forecast, or why there is none.
fn summary(place: &Located, forecast: &Value, others: &[String], approximate: bool) -> Result<String, String> {
    if forecast.get("current").is_none() && forecast.get("daily").is_none() {
        return Err("the weather service gave no forecast for this place".into());
    }
    let mut result = json!({
        "place": { "name": place.name, "country": place.country },
        "timezone": forecast.get("timezone"),
        "current": forecast.get("current"),
        "current_units": forecast.get("current_units"),
        "daily": forecast.get("daily"),
        "daily_units": forecast.get("daily_units"),
        "source": SOURCE,
    });
    if approximate {
        result["approximate"] = json!("found by IP, which can be another city; say which place this is for");
    }
    if !others.is_empty() {
        result["other_places_of_that_name"] = json!(others);
    }
    Ok(result.to_string())
}

fn forecast_url(api: &WeatherApi, place: &Located, days: u8) -> Result<Url, String> {
    // About a kilometre: a forecast needs no more, and the service keeps its logs for 90 days.
    let round = |v: f64| format!("{:.2}", v);
    Url::parse_with_params(
        &api.forecast,
        [
            ("latitude", round(place.latitude)),
            ("longitude", round(place.longitude)),
            ("forecast_days", days.to_string()),
            ("timezone", "auto".to_owned()),
            ("wind_speed_unit", "ms".to_owned()),
            (
                "current",
                "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m"
                    .to_owned(),
            ),
            (
                "daily",
                "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max"
                    .to_owned(),
            ),
        ],
    )
    .map_err(|_| "the weather service's address is not valid".to_owned())
}

async fn named(http: &ProviderHttp, api: &WeatherApi, place: &str, days: u8) -> Result<String, String> {
    let name = place.split(',').next().unwrap_or(place).trim();
    let search = Url::parse_with_params(&api.geocoding, [("name", name), ("count", MATCHES), ("format", "json")])
        .map_err(|_| "the weather service's address is not valid".to_owned())?;
    let found = get(http, search).await?;
    let Some((located, others)) = choose(&found, place) else {
        return Err(format!("no place named {name} was found; try its name in English, or a larger town nearby"));
    };
    let forecast = get(http, forecast_url(api, &located, days)?).await?;
    summary(&located, &forecast, &others, false)
}

async fn at(http: &ProviderHttp, api: &WeatherApi, place: &Located, days: u8) -> Result<String, String> {
    let forecast = get(http, forecast_url(api, place, days)?).await?;
    summary(place, &forecast, &[], true)
}

fn answer(result: Result<String, String>) -> String {
    result.unwrap_or_else(|why| tools::error(&why))
}

/// The forecast of a place the model named.
pub async fn for_name(http: &ProviderHttp, api: &WeatherApi, place: &str, days: u8) -> String {
    match tokio::time::timeout(TIME_MAX, named(http, api, place, days)).await {
        Ok(result) => answer(result),
        Err(_) => tools::error("the weather service took too long; try again later"),
    }
}

/// The forecast of the session's place, which the user approved.
pub async fn for_session(http: &ProviderHttp, api: &WeatherApi, place: &Located, days: u8) -> String {
    match tokio::time::timeout(TIME_MAX, at(http, api, place, days)).await {
        Ok(result) => answer(result),
        Err(_) => tools::error("the weather service took too long; try again later"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn oslo() -> Located {
        Located { name: "Oslo".into(), country: "Norway".into(), latitude: 59.913_868, longitude: 10.752_245 }
    }

    #[test]
    fn a_place_is_a_name_and_nothing_else() {
        assert_eq!(check_place("  Санкт-Петербург ").as_deref(), Ok("Санкт-Петербург"));
        assert_eq!(check_place("Paris, Texas").as_deref(), Ok("Paris, Texas"));
        assert_eq!(check_place("St. John's").as_deref(), Ok("St. John's"));
        for bad in ["", "   ", "Oslo?weight=81", "a@b.com", "81.5 kg", "https://evil.example", "x/y"] {
            assert!(check_place(bad).is_err(), "{bad}");
        }
        assert!(check_place(&"a".repeat(PLACE_MAX + 1)).is_err());
    }

    #[test]
    fn coordinates_leave_rounded_and_nothing_of_the_user_with_them() {
        let url = forecast_url(&WeatherApi::open_meteo(), &oslo(), 3).unwrap();
        let query = url.query().unwrap();
        assert!(query.contains("latitude=59.91&longitude=10.75") && query.contains("forecast_days=3"), "{query}");
    }

    #[test]
    fn the_comma_chooses_among_places_of_a_name() {
        let found = json!({ "results": [
            { "name": "Paris", "country": "France", "admin1": "Île-de-France", "latitude": 48.85, "longitude": 2.35 },
            { "name": "Paris", "country": "United States", "admin1": "Texas", "latitude": 33.66, "longitude": -95.55 },
        ]});
        let (first, others) = choose(&found, "Paris").unwrap();
        assert_eq!(first.country, "France");
        assert_eq!(others, ["Paris, United States"]);
        assert_eq!(choose(&found, "Paris, Texas").unwrap().0.country, "United States");
        // A hint nothing matches still answers, with the others named.
        assert_eq!(choose(&found, "Paris, Mars").unwrap().0.country, "France");
        assert!(choose(&json!({ "generationtime_ms": 0.1 }), "Nowhere").is_none());
        assert!(choose(&json!({ "results": [{ "name": "x" }] }), "x").is_none());
    }

    #[test]
    fn a_forecast_says_its_place_and_source_and_an_empty_one_is_an_error() {
        let forecast = json!({ "timezone": "Europe/Oslo", "current": { "temperature_2m": 4.5 } });
        let text = summary(&oslo(), &forecast, &[], true).unwrap();
        let read: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(read["place"]["name"], "Oslo");
        assert_eq!(read["current"]["temperature_2m"], 4.5);
        assert_eq!(read["source"], SOURCE);
        assert!(read["approximate"].is_string());
        assert!(summary(&oslo(), &forecast, &[], false).unwrap().find("approximate").is_none());
        assert!(summary(&oslo(), &json!({ "error": true }), &[], false).is_err());
    }

    #[tokio::test]
    async fn a_service_out_of_reach_is_the_models_to_hear() {
        let http = ProviderHttp::new(crate::providers::AddressPolicy::default());
        let api = WeatherApi { geocoding: "https://127.0.0.1/s".into(), forecast: "https://127.0.0.1/f".into() };
        assert!(for_name(&http, &api, "Oslo", 1).await.contains("error"));
        assert!(for_session(&http, &api, &oslo(), 1).await.contains("error"));
    }
}
