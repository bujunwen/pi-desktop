import { StringDecoder } from "node:string_decoder";

export class JsonlDecoder<T> {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: Buffer | string): T[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    return this.#drainLines();
  }

  end(): T[] {
    this.#buffer += this.#decoder.end();
    const records = this.#drainLines();

    if (this.#buffer.length > 0) {
      records.push(this.#parse(this.#stripCarriageReturn(this.#buffer)));
      this.#buffer = "";
    }

    return records;
  }

  #drainLines(): T[] {
    const records: T[] = [];

    while (true) {
      const newlineIndex = this.#buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      const line = this.#stripCarriageReturn(this.#buffer.slice(0, newlineIndex));
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.length > 0) records.push(this.#parse(line));
    }

    return records;
  }

  #stripCarriageReturn(line: string): string {
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  }

  #parse(line: string): T {
    return JSON.parse(line) as T;
  }
}
