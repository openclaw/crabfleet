import { routeProductRequest } from "./canonical-host";

export default {
  async fetch(request: Request): Promise<Response> {
    return routeProductRequest(request);
  },
};
