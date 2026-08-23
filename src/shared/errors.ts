/** Thrown by a declared contract whose implementation has not landed yet. */
export class NotImplementedError extends Error {
  constructor(what: string, phase: string) {
    super(`${what} is not implemented yet — arrives in ${phase}`);
    this.name = "NotImplementedError";
  }
}
