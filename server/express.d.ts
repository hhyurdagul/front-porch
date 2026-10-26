declare module "express" {
  import type { IncomingMessage, ServerResponse, Server } from "node:http";
  interface Request extends IncomingMessage {
    body: unknown;
    params: Record<string, string>;
    query: Record<string, unknown>;
    get(name: string): string | undefined;
  }
  interface Response extends ServerResponse {
    status(code: number): Response;
    json(value: unknown): void;
    type(value: string): Response;
    send(value: unknown): void;
    sendFile(path: string): void;
  }
  type Next = (err?: unknown) => void;
  type Handler = (req: Request, res: Response, next: Next) => unknown;
  interface App {
    use(...args: unknown[]): void;
    get(path: string, handler: Handler): void;
    post(path: string, handler: Handler): void;
    listen(port: number, host: string, cb?: () => void): Server;
    disable(name: string): void;
  }
  interface Factory {
    (): App;
    json(options: object): Handler;
    static(path: string): Handler;
  }
  const express: Factory;
  export default express;
  export type { Request, Response, Next, Handler };
}
