const rows = [
  { title: "The fight over what counts as intelligence", show: "HARD FORK",           dur: "1:12:04", durMin: 72,  size: "41.2M", sizeMB: 41.2, kind: "AUDIO" },
  { title: "The last lighthouse keeper",                 show: "99% INVISIBLE",       dur: "44:18",   durMin: 44,  size: "18.9M", sizeMB: 18.9, kind: "AUDIO" },
  { title: "AI agents, copyright panic, and a hat",      show: "HARD FORK",           dur: "1:03:47", durMin: 64,  size: "38.1M", sizeMB: 38.1, kind: "VIDEO" },
  { title: "Why copper is the new oil",                  show: "ODD LOTS · BLOOMBERG", dur: "52:10",   durMin: 52,  size: "22.4M", sizeMB: 22.4, kind: "AUDIO" },
  { title: "The man who remade time",                    show: "RADIOLAB",            dur: "38:02",   durMin: 38,  size: "16.0M", sizeMB: 16.0, kind: "AUDIO" },
  { title: "Inside a 300-year-old bank",                 show: "PLANET MONEY",        dur: "29:45",   durMin: 30,  size: "12.7M", sizeMB: 12.7, kind: "AUDIO" },
  { title: "What a bee sees",                            show: "RADIOLAB",            dur: "35:18",   durMin: 35,  size: "14.8M", sizeMB: 14.8, kind: "AUDIO" },
  { title: "The accidental cartographer",                show: "SEARCH ENGINE",       dur: "1:08:33", durMin: 68,  size: "39.4M", sizeMB: 39.4, kind: "AUDIO" },
  { title: "A brief history of the open plan office",    show: "99% INVISIBLE",       dur: "41:02",   durMin: 41,  size: "17.3M", sizeMB: 17.3, kind: "AUDIO" },
  { title: "The quiet comeback of the sailboat",         show: "THE DAILY · NY TIMES", dur: "28:40",   durMin: 29,  size: "12.0M", sizeMB: 12.0, kind: "AUDIO" },
  { title: "When cities run out of water",               show: "THE EZRA KLEIN SHOW", dur: "1:24:12", durMin: 84,  size: "48.8M", sizeMB: 48.8, kind: "AUDIO" },
  { title: "The economics of attention",                 show: "ACQUIRED",            dur: "2:48:09", durMin: 168, size: "97.6M", sizeMB: 97.6, kind: "VIDEO" },
  { title: "Who owns the sound of an airport?",          show: "99% INVISIBLE",       dur: "36:22",   durMin: 36,  size: "15.3M", sizeMB: 15.3, kind: "AUDIO" },
  { title: "The librarian who saved a country",          show: "THE REST IS HISTORY", dur: "58:40",   durMin: 59,  size: "25.2M", sizeMB: 25.2, kind: "AUDIO" },
  { title: "Forty seconds on the moon",                  show: "RADIOLAB",            dur: "42:09",   durMin: 42,  size: "17.8M", sizeMB: 17.8, kind: "AUDIO" },
  { title: "The map of the world's undersea cables",     show: "DARKNET DIARIES",     dur: "1:02:11", durMin: 62,  size: "36.0M", sizeMB: 36.0, kind: "AUDIO" },
  { title: "Why the 2000s sound so strange now",         show: "SEARCH ENGINE",       dur: "48:03",   durMin: 48,  size: "20.3M", sizeMB: 20.3, kind: "AUDIO" },
  { title: "How a typeface built an airline",            show: "99% INVISIBLE",       dur: "32:50",   durMin: 33,  size: "13.9M", sizeMB: 13.9, kind: "AUDIO" },
  { title: "Inside the last radio station",              show: "REPLY ALL",           dur: "51:19",   durMin: 51,  size: "21.7M", sizeMB: 21.7, kind: "AUDIO" },
  { title: "The physicist who listens to earthquakes",   show: "RADIOLAB",            dur: "44:55",   durMin: 45,  size: "19.0M", sizeMB: 19.0, kind: "AUDIO" },
  { title: "A year in the life of a single tomato",      show: "THE DAILY · NY TIMES", dur: "27:10",   durMin: 27,  size: "11.4M", sizeMB: 11.4, kind: "AUDIO" },
  { title: "The case for boring software",               show: "DITHERING",           dur: "15:22",   durMin: 15,  size: "6.5M",  sizeMB: 6.5,  kind: "AUDIO" },
  { title: "Why film grain won't die",                   show: "THE VERGECAST",       dur: "1:19:08", durMin: 79,  size: "45.9M", sizeMB: 45.9, kind: "VIDEO" },
  { title: "The secret life of hotel carpets",           show: "99% INVISIBLE",       dur: "39:44",   durMin: 40,  size: "16.8M", sizeMB: 16.8, kind: "AUDIO" },
  { title: "Agents, ghosts, and the attention economy",  show: "HARD FORK",           dur: "57:12",   durMin: 57,  size: "33.2M", sizeMB: 33.2, kind: "VIDEO" },
  { title: "The man who counts coastlines",              show: "RADIOLAB",            dur: "36:40",   durMin: 37,  size: "15.5M", sizeMB: 15.5, kind: "AUDIO" },
  { title: "The cult of carbon fiber",                   show: "SEARCH ENGINE",       dur: "43:01",   durMin: 43,  size: "18.2M", sizeMB: 18.2, kind: "AUDIO" },
  { title: "Are we running out of rivers?",              show: "THE EZRA KLEIN SHOW", dur: "1:10:55", durMin: 71,  size: "41.1M", sizeMB: 41.1, kind: "AUDIO" },
];

export const upNext = rows.map((r, i) => ({ id: i + 1, ...r }));

export const onDevice = [
  { id: 900, title: "The accidental cartographer (yesterday)", show: "SEARCH ENGINE", size: "39.4M", sizeMB: 39.4, fname: "01_search.mp3" },
  { id: 901, title: "Forty seconds on the moon (yesterday)",   show: "RADIOLAB",      size: "17.8M", sizeMB: 17.8, fname: "02_radiolab.mp3" },
];

export const deviceCapacityMB = 6200;
