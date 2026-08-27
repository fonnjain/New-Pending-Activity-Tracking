/**
 * Express can type route parameters as a string, an array, or undefined.
 * Route handlers that need one value must narrow that shape before passing it
 * to a database query.
 */
export type RouteParamValue = string | string[] | undefined;

export function getSingleRouteParam(value: RouteParamValue): string | null {
  return typeof value === "string" ? value : null;
}