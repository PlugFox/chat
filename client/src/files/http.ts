/**
 * `PUT` and `GET /files/{id}` (docs/protocol.md, "Files") with the access
 * token, one refresh and retry on 401 as `/auth` calls make.
 */
import type { AuthClient } from "../auth/client";
import type { ErrorPayload } from "../protocol/generated/protocol";
import type { FileHttp } from "./chat-files";

/** A refused or failed transfer; `code` is the error payload's, or `network`. */
export class FileHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`file transfer failed: ${code}`);
  }
}

async function failure(response: Response): Promise<FileHttpError> {
  let code = "internal";
  try {
    code = ((await response.json()) as ErrorPayload).code;
  } catch {
    // Not our JSON (a proxy's page): the status says enough.
  }
  return new FileHttpError(response.status, code);
}

/** Past the server's own limit on a transfer (docs/protocol.md, "Files"). */
const TRANSFER_LIMIT = 16 * 60 * 1000;

export function fileHttp(auth: AuthClient, fetcher: typeof fetch = (input, init) => fetch(input, init)): FileHttp {
  const send = async (method: "PUT" | "GET", fileId: string, body?: Blob): Promise<Response> => {
    for (const force of [false, true]) {
      const { token } = await auth.accessToken(force);
      const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` }, credentials: "same-origin" };
      if (body) init.body = body;
      // The server ends a transfer after 15 minutes; a connection that went
      // quiet without closing ends here.
      init.signal = AbortSignal.timeout(TRANSFER_LIMIT);
      let response: Response;
      try {
        response = await fetcher(`/files/${fileId}`, init);
      } catch {
        throw new FileHttpError(0, "network");
      }
      if (response.status !== 401 || force) return response;
    }
    throw new FileHttpError(401, "auth.invalid_token");
  };
  return {
    async put(fileId, object) {
      const response = await send("PUT", fileId, object);
      if (!response.ok) throw await failure(response);
    },
    async get(fileId) {
      const response = await send("GET", fileId);
      if (!response.ok) throw await failure(response);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
