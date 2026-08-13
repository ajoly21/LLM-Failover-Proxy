import zlib from "node:zlib";

/**
 * Just enough tar to pull one executable out of a `.tar.gz` release.
 *
 * Node ships gzip but no tar, and the alternative — shelling out to the system
 * `tar` — bets on a binary that a minimal container may not have, on three
 * platforms, for a format that is a list of 512-byte headers. This reads the
 * fields it needs and ignores the rest, which is why it fits in a screen.
 */

const BLOCK = 512;

/** Header fields are NUL- or space-padded octal, and an empty one means zero. */
function octal(buffer, offset, length) {
  const text = buffer.toString("ascii", offset, offset + length).replace(/\0.*$/, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function name(buffer) {
  const main = buffer.toString("utf8", 0, 100).replace(/\0.*$/, "");
  // ustar splits long paths in two, and the prefix comes first when present.
  const prefix = buffer.toString("utf8", 345, 500).replace(/\0.*$/, "");
  return prefix ? `${prefix}/${main}` : main;
}

/**
 * Every regular file in `buffer`, as `{ name, data }`, in the order stored.
 *
 * @param {Buffer} buffer an uncompressed tar
 */
export function untar(buffer) {
  const files = [];
  let offset = 0;
  let longName = null; // set by a GNU LongName header, consumed by the next entry

  while (offset + BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK);
    // Two zero blocks end the archive; one is enough to stop reading.
    if (header.every((byte) => byte === 0)) break;

    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156]) || "0";
    const start = offset + BLOCK;
    const data = buffer.subarray(start, start + size);
    // Payloads are padded to a whole number of blocks.
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    // "0" and NUL are regular files; "x"/"g" are pax metadata, the rest are
    // directories, links and devices, none of which a release archive needs.
    if (type !== "0" && type !== "\0") {
      longName = null;
      continue;
    }
    files.push({ name: longName ?? name(header), data });
    longName = null;
  }
  return files;
}

/**
 * The first file in a gzipped tar whose base name satisfies `matches`.
 *
 * @returns {Buffer|null}
 */
export function extractFromTarGz(gzipped, matches) {
  for (const file of untar(zlib.gunzipSync(gzipped))) {
    const base = file.name.split("/").pop();
    if (matches(base)) return Buffer.from(file.data);
  }
  return null;
}
