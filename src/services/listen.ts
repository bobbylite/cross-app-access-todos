import type express from "express";

/** Resolves once bound, and rejects with something readable if the port is taken. */
export function listen(app: express.Express, port: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);
    server.once("listening", () => resolve());
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} (${label}) is already in use`)
          : error,
      );
    });
  });
}
