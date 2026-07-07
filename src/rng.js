// Seeded RNG (mulberry32) + value noise for procedural worldgen.

export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    shuffle(arr) {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [a2[i], a2[j]] = [a2[j], a2[i]];
      }
      return a2;
    },
  };
}

// 2D value noise with fractal octaves
export function makeNoise(rng, size = 256) {
  const grid = new Float32Array(size * size);
  for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
  const at = (x, y) => grid[((y % size + size) % size) * size + ((x % size + size) % size)];
  const smooth = (t) => t * t * (3 - 2 * t);

  function noise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  }

  return function fractal(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise2(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  };
}
