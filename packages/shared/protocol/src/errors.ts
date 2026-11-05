/** A safe operation error that can cross an Aura host transport. */
export class FlowError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
