import http from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

http
  .createServer((request, response) => {
    const chunks = [];
    let byteLength = 0;

    request.on("data", (chunk) => {
      byteLength += chunk.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(byteLength),
      });
      response.end(Buffer.concat(chunks));
      for (const chunk of chunks) {
        chunk.fill(0);
      }
    });
  })
  .listen(8080, "0.0.0.0");
