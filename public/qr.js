(function () {
  // Compact zero-dependency QR Code SVG generator (Byte mode, ECC Level M, Versions 1..10)
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  let v = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = v;
    LOG[v] = i;
    v <<= 1;
    if (v & 256) v ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function rsGeneratorPoly(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = EXP[i];
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsRemainder(data, ecLen) {
    const gen = rsGeneratorPoly(ecLen);
    const res = new Uint8Array(ecLen);
    for (let i = 0; i < data.length; i += 1) {
      const factor = data[i] ^ res[0];
      res.copyWithin(0, 1);
      res[ecLen - 1] = 0;
      for (let j = 0; j < ecLen; j += 1) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return res;
  }

  // Version table for ECC Level M: [totalCodewords, ecPerBlock, blocksGroup1, dataGroup1, blocksGroup2, dataGroup2, alignCoords]
  const VERSIONS_M = {
    1: [26, 10, 1, 16, 0, 0, []],
    2: [44, 16, 1, 28, 0, 0, [6, 18]],
    3: [70, 26, 1, 44, 0, 0, [6, 22]],
    4: [100, 18, 2, 32, 0, 0, [6, 26]],
    5: [134, 24, 2, 43, 0, 0, [6, 30]],
    6: [172, 16, 4, 27, 0, 0, [6, 34]],
    7: [196, 18, 4, 31, 0, 0, [6, 22, 38]],
    8: [242, 22, 2, 38, 2, 39, [6, 24, 42]],
    9: [292, 22, 3, 36, 2, 37, [6, 26, 46]],
    10: [346, 26, 4, 43, 1, 44, [6, 28, 50]]
  };

  function encodeData(text) {
    const bytes = new TextEncoder().encode(text);
    let version = 0;
    for (let ver = 1; ver <= 10; ver += 1) {
      const [, , b1, d1, b2, d2] = VERSIONS_M[ver];
      const capBits = (b1 * d1 + b2 * d2) * 8;
      const ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= capBits) {
        version = ver;
        break;
      }
    }
    if (!version) throw new Error('QR payload too long');

    const [, ecLen, b1, d1, b2, d2] = VERSIONS_M[version];
    const totalDataBytes = b1 * d1 + b2 * d2;
    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1);
    };

    pushBits(0b0100, 4); // Byte mode
    pushBits(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) pushBits(b, 8);
    const maxBits = totalDataBytes * 8;
    pushBits(0, Math.min(4, maxBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    let padByte = 0xec;
    while (bits.length < maxBits) {
      pushBits(padByte, 8);
      padByte = padByte === 0xec ? 0x11 : 0xec;
    }

    const dataBytes = new Uint8Array(totalDataBytes);
    for (let i = 0; i < totalDataBytes; i += 1) {
      let b = 0;
      for (let j = 0; j < 8; j += 1) b = (b << 1) | bits[i * 8 + j];
      dataBytes[i] = b;
    }

    const blocks = [];
    const ecs = [];
    let offset = 0;
    for (let i = 0; i < b1; i += 1) {
      const blk = dataBytes.slice(offset, offset + d1);
      offset += d1;
      blocks.push(blk);
      ecs.push(rsRemainder(blk, ecLen));
    }
    for (let i = 0; i < b2; i += 1) {
      const blk = dataBytes.slice(offset, offset + d2);
      offset += d2;
      blocks.push(blk);
      ecs.push(rsRemainder(blk, ecLen));
    }

    const codewords = [];
    const maxDataLen = Math.max(d1, d2);
    for (let i = 0; i < maxDataLen; i += 1) {
      for (const blk of blocks) if (i < blk.length) codewords.push(blk[i]);
    }
    for (let i = 0; i < ecLen; i += 1) {
      for (const ec of ecs) codewords.push(ec[i]);
    }
    return { version, codewords };
  }

  function buildMatrix(version, codewords) {
    const size = version * 4 + 17;
    const mat = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
    const func = Array.from({ length: size }, () => new Uint8Array(size));

    const setFunc = (r, c, val) => {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        mat[r][c] = val ? 1 : 0;
        func[r][c] = 1;
      }
    };

    const drawFinder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr += 1) {
        for (let dc = -1; dc <= 7; dc += 1) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const on =
            (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
            (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6)) ||
            (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          setFunc(r, c, on);
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i += 1) {
      setFunc(6, i, i % 2 === 0);
      setFunc(i, 6, i % 2 === 0);
    }

    const align = VERSIONS_M[version][6];
    for (const r of align) {
      for (const c of align) {
        if (func[r][c]) continue;
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setFunc(r + dr, c + dc, on);
          }
        }
      }
    }

    // Reserve format info + dark module
    for (let i = 0; i < 9; i += 1) {
      if (i !== 6) {
        setFunc(8, i, 0);
        setFunc(i, 8, 0);
      }
    }
    for (let i = 0; i < 8; i += 1) {
      setFunc(8, size - 1 - i, 0);
      setFunc(size - 1 - i, 8, 0);
    }
    setFunc(size - 8, 8, 1);

    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i += 1) {
        const bit = (bits >>> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunc(a, b, bit);
        setFunc(b, a, bit);
      }
    }

    // Place data bits
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert += 1) {
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j += 1) {
          const c = right - j;
          if (!func[r][c]) {
            let bit = 0;
            if (bitIdx < totalBits) {
              bit = (codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
              bitIdx += 1;
            }
            mat[r][c] = bit;
          }
        }
      }
    }

    const maskPred = [
      (r, c) => (r + c) % 2 === 0,
      (r) => r % 2 === 0,
      (_, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
      (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
      (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    ];

    const applyMaskAndFormat = (mIdx) => {
      const cloned = mat.map((row) => Int8Array.from(row));
      const pred = maskPred[mIdx];
      for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          if (!func[r][c] && pred(r, c)) cloned[r][c] ^= 1;
        }
      }
      // Format bits for ECC M (00) + mask (3 bits)
      const data5 = (0b00 << 3) | mIdx;
      let rem = data5;
      for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const fmt = ((data5 << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i += 1) cloned[8][i] = (fmt >>> i) & 1;
      cloned[8][7] = (fmt >>> 6) & 1;
      cloned[8][8] = (fmt >>> 7) & 1;
      cloned[7][8] = (fmt >>> 8) & 1;
      for (let i = 9; i < 15; i += 1) cloned[14 - i][8] = (fmt >>> i) & 1;
      for (let i = 0; i < 8; i += 1) cloned[8][size - 1 - i] = (fmt >>> i) & 1;
      for (let i = 8; i < 15; i += 1) cloned[size - 15 + i][8] = (fmt >>> i) & 1;
      return cloned;
    };

    const penalty = (g) => {
      let score = 0;
      for (let r = 0; r < size; r += 1) {
        let run = 1;
        for (let c = 1; c < size; c += 1) {
          if (g[r][c] === g[r][c - 1]) run += 1;
          else {
            if (run >= 5) score += 3 + (run - 5);
            run = 1;
          }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
      for (let c = 0; c < size; c += 1) {
        let run = 1;
        for (let r = 1; r < size; r += 1) {
          if (g[r][c] === g[r - 1][c]) run += 1;
          else {
            if (run >= 5) score += 3 + (run - 5);
            run = 1;
          }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
      for (let r = 0; r < size - 1; r += 1) {
        for (let c = 0; c < size - 1; c += 1) {
          const s = g[r][c] + g[r][c + 1] + g[r + 1][c] + g[r + 1][c + 1];
          if (s === 0 || s === 4) score += 3;
        }
      }
      return score;
    };

    let best = null;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m += 1) {
      const candidate = applyMaskAndFormat(m);
      const s = penalty(candidate);
      if (s < bestScore) {
        bestScore = s;
        best = candidate;
      }
    }
    return best;
  }

  window.renderQrSvg = function renderQrSvg(text, px = 176) {
    const { version, codewords } = encodeData(String(text || ''));
    const grid = buildMatrix(version, codewords);
    const size = grid.length;
    const quiet = 2;
    const total = size + quiet * 2;
    let rects = '';
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (grid[r][c] === 1) {
          rects += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="2FA QR-Code"><rect width="100%" height="100%" fill="#ffffff"/><g fill="#111111">${rects}</g></svg>`;
  };
})();
