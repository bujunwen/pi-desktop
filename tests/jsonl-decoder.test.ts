import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../src/main/jsonl-decoder";

describe("JsonlDecoder", () => {
  it("decodes LF-delimited records across chunks", () => {
    const decoder = new JsonlDecoder<{ text: string }>();

    expect(decoder.push('{"text":"hel')).toEqual([]);
    expect(decoder.push('lo"}\n{"text":"world"}\n')).toEqual([
      { text: "hello" },
      { text: "world" },
    ]);
  });

  it("does not split JSON strings on Unicode line separators", () => {
    const decoder = new JsonlDecoder<{ text: string }>();
    const line = `${JSON.stringify({ text: "first\u2028second\u2029third" })}\n`;

    expect(decoder.push(line)).toEqual([{ text: "first\u2028second\u2029third" }]);
  });

  it("preserves split UTF-8 characters", () => {
    const decoder = new JsonlDecoder<{ text: string }>();
    const bytes = Buffer.from(`${JSON.stringify({ text: "你好" })}\n`);
    const split = bytes.indexOf(Buffer.from("你")) + 1;

    expect(decoder.push(bytes.subarray(0, split))).toEqual([]);
    expect(decoder.push(bytes.subarray(split))).toEqual([{ text: "你好" }]);
  });

  it("accepts CRLF input and a final record without LF", () => {
    const decoder = new JsonlDecoder<{ value: number }>();

    expect(decoder.push('{"value":1}\r\n{"value":2}')).toEqual([{ value: 1 }]);
    expect(decoder.end()).toEqual([{ value: 2 }]);
  });
});
