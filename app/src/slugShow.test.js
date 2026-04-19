import { describe, it, expect } from "vitest";
import { slugShow, fnameFor } from "./slugShow.js";

describe("slugShow", () => {
  it("drops leading stopwords so The Daily doesn't become 'the'", () => {
    expect(slugShow("THE DAILY · NY TIMES")).toBe("dailynytimes");
    expect(slugShow("THE EZRA KLEIN SHOW")).toBe("ezraklein");
    expect(slugShow("THE REST IS HISTORY")).toBe("resthistory");
    expect(slugShow("THE VERGECAST")).toBe("vergecast");
  });

  it("keeps single-word show names intact", () => {
    expect(slugShow("RADIOLAB")).toBe("radiolab");
    expect(slugShow("ACQUIRED")).toBe("acquired");
    expect(slugShow("DITHERING")).toBe("dithering");
  });

  it("concatenates words to reach a readable minimum length", () => {
    expect(slugShow("HARD FORK")).toBe("hardfork");
    expect(slugShow("PLANET MONEY")).toBe("planetmoney");
    expect(slugShow("REPLY ALL")).toBe("replyall");
    expect(slugShow("ODD LOTS · BLOOMBERG")).toBe("oddlotsbloom");
  });

  it("caps length at 12 characters", () => {
    expect(slugShow("DARKNET DIARIES").length).toBeLessThanOrEqual(12);
    expect(slugShow("SEARCH ENGINE").length).toBeLessThanOrEqual(12);
    expect(slugShow("99% INVISIBLE IS A VERY LONG SHOW NAME").length).toBeLessThanOrEqual(12);
  });

  it("skips stopwords like 'podcast' and 'show' from suffixes", () => {
    expect(slugShow("AI ENGINEER PODCAST")).toBe("aiengineer");
    expect(slugShow("HARD FORK PODCAST")).toBe("hardfork");
    expect(slugShow("GRADIENT DESCENT PODCAST").startsWith("gradient")).toBe(true);
  });

  it("keeps digits in names", () => {
    expect(slugShow("99% INVISIBLE")).toBe("99invisible");
    expect(slugShow("20VC")).toBe("20vc");
  });

  it("falls back to 'show' for empty or punctuation-only input", () => {
    expect(slugShow("")).toBe("show");
    expect(slugShow("···")).toBe("show");
    expect(slugShow(null)).toBe("show");
  });

  it("uses original words if every token is a stopword (degenerate case)", () => {
    expect(slugShow("THE SHOW")).toBe("theshow");
  });
});

describe("fnameFor", () => {
  it("produces zero-padded slot prefix + slug + extension", () => {
    expect(fnameFor("HARD FORK", 1)).toBe("01_hardfork.mp3");
    expect(fnameFor("THE DAILY · NY TIMES", 7)).toBe("07_dailynytimes.mp3");
    expect(fnameFor("RADIOLAB", 12)).toBe("12_radiolab.mp3");
  });

  it("sorts alphanumerically in slot order regardless of slug", () => {
    const shows = ["RADIOLAB", "HARD FORK", "THE DAILY"];
    const names = shows.map((s, i) => fnameFor(s, i + 1));
    const sorted = [...names].sort();
    expect(sorted).toEqual(names);
  });
});
