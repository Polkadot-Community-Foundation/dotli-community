export class ProtocolFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolFatalError";
  }
}

export class ProtocolInitFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolInitFailedError";
  }
}
