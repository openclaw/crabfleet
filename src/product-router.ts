import { routeProductRequest } from "./canonical-host";

export default {
  fetch(request: Request): Response {
    return routeProductRequest(request);
  },
};
