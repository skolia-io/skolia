/** The ingest container's blob store: GET, HEAD and PUT /{key} on its intercepted host
 * (BLOBS_HOST), served from the R2 binding. The container has no R2 credentials.
 * GET answers with the stored bytes as they are, still compressed if they were put with
 * an encoding. A PUT's Content-Encoding goes in BLOB_ENCODING, so that nothing between
 * the container and here decodes the body. */

export const BLOBS_HOST = "blobs.internal";
export const BLOB_ENCODING = "x-blob-content-encoding";

export async function serveBlob(bucket: R2Bucket, request: Request): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  if (key === "") return new Response("no key", { status: 400 });
  switch (request.method) {
    case "GET": {
      const object = await bucket.get(key);
      return object === null ? new Response(null, { status: 404 }) : new Response(object.body);
    }
    case "HEAD":
      return new Response(null, { status: (await bucket.head(key)) === null ? 404 : 200 });
    case "PUT": {
      const contentType = request.headers.get("content-type");
      const contentEncoding = request.headers.get(BLOB_ENCODING);
      await bucket.put(key, await request.arrayBuffer(), {
        httpMetadata: {
          ...(contentType === null ? {} : { contentType }),
          ...(contentEncoding === null ? {} : { contentEncoding }),
        },
      });
      return new Response(null, { status: 204 });
    }
    default:
      return new Response(null, { status: 405, headers: { allow: "GET, HEAD, PUT" } });
  }
}
