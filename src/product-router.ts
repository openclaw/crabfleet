import { routeProductRequest } from "./canonical-host.ts";

export default {
  fetch(request: Request): Response {
    return routeProductRequest(request);
  },
};
