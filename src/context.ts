import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext { visitor: string; ip: string; operator: boolean }
export const requestContext = new AsyncLocalStorage<RequestContext>();
export const visitorId = () => requestContext.getStore()?.visitor ?? null;
export function owns(row: { visitor_id: string | null } | null) {
  return !!row && (row.visitor_id === visitorId() || (row.visitor_id === null && requestContext.getStore()?.operator === true));
}
