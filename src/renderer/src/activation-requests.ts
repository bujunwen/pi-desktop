export class ActivationRequests {
  #latest = 0;

  begin(): number {
    this.#latest += 1;
    return this.#latest;
  }

  current(): number {
    return this.#latest;
  }

  isCurrent(requestId: number): boolean {
    return requestId === this.#latest;
  }
}
