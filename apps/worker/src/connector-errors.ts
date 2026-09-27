/**
 * Connector error taxonomy.
 *
 * The dispatcher may retry automatically ONLY when the foreign effect is
 * known not to have happened. Anything else about a consequential write is
 * AMBIGUOUS and goes to read-back reconciliation by the original
 * execution_id; it is never blindly executed again.
 */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}
/** The request never reached the foreign system (pre-send, explicit 429...). */
export class SafeRetryableConnectorError extends ConnectorError {}
/** The foreign system definitively refused; nothing was committed. */
export class PermanentConnectorError extends ConnectorError {}
/** The foreign system may have committed (timeout after send, lost connection). */
export class AmbiguousConnectorError extends ConnectorError {}
export class UnsupportedOperationError extends ConnectorError {
  constructor(readonly capability: string) {
    super(`capability ${capability} is not supported`, "UNSUPPORTED_OPERATION");
  }
}
/** Response could not be parsed; the effect may have happened. */
export class InvalidConnectorResponseError extends ConnectorError {}
