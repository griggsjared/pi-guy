import assert from "node:assert/strict";
import { test } from "node:test";
import { boxed } from "../../src/lib/box.ts";
import { fakeTheme } from "../helpers/theme.ts";

const theme = fakeTheme();
const plain = (lines: string[]) => lines.map((line) => line.replaceAll("\x1b[0m", ""));

test("boxed centers the title in the bottom border and pads or clips each line to the box width", () => {
  assert.deepEqual(plain(boxed(["hello", "a line that is too long"], 12, theme, "btw")), [
    "│hello     │",
    "│a line tha│",
    "╰── btw ───╯",
  ]);
});

test("boxed draws a plain bottom border without a title and drops the border when too narrow", () => {
  assert.deepEqual(boxed(["x"], 5, theme), ["│x  │", "╰───╯"]);
  assert.deepEqual(plain(boxed(["hello"], 2, theme)), ["he"]);
  assert.deepEqual(plain(boxed(["hello"], 0, theme)), ["h"]);
});
