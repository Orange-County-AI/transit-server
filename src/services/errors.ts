/**
 * A failure a service reports, in both the shapes its callers need.
 *
 * `code` is the stable machine string the REST API returns in a JSON body and
 * maps to a status; `message` is the sentence a tool result carries. Both are
 * part of a contract somebody already depends on, and neither derives from the
 * other, so a service names both rather than letting one transport's wording
 * leak into the other's.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
