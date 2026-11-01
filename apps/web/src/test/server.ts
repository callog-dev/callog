import { setupServer } from "msw/node";

/** API mocks: each test adds the handlers it needs with `server.use(...)`. */
export const server = setupServer();
