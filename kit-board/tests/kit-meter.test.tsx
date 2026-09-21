import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Meter } from '@/components/kit/meter';

const M = (v: number) => `${v.toFixed(2)}M`;
const render = (props: { used: number; projected?: number; limit: number }) =>
  renderToStaticMarkup(<Meter {...props} formatValue={M} />);

// The primitive takes consumption (what a provider reports) and draws what is left, so the gauge
// starts full and retreats. These assertions are what would fail if someone flipped it back.
test('the meter draws what is left, with the forecast eating the right edge of the fill', () => {
  const html = render({ used: 2.14, projected: 3.16, limit: 5 });
  assert.match(html, /role="meter"[^>]*aria-valuemax="5"[^>]*aria-valuenow="2.86"/, 'valuenow is remaining, in the caller’s own units');
  assert.match(html, /aria-label="2\.86M of 5\.00M left; 1\.84M left at the end of the window"/);
  assert.match(html, /bg-primary[^>]*style="width:36\.8%"/, '36.8% survives the window');
  assert.match(html, /style="left:36\.8%;width:20\.4%"/, 'the forecast takes the 20.4% beside it, not a slice past the used fill');
  assert.match(html, /1\.84M left at reset/);
  assert.doesNotMatch(html, /used/, 'no level on this meter is described as consumed');
});

test('a projection past the limit consumes the whole remaining fill and says so', () => {
  const html = render({ used: 4.2, projected: 5.6, limit: 5 });
  assert.match(html, /aria-label="0\.80M of 5\.00M left; projected to run out, 0\.60M beyond the allowance"/);
  assert.match(html, /bg-primary[^>]*style="width:0%"/, 'nothing survives, so the solid fill is gone');
  assert.match(html, /style="left:0%;width:16%"/, 'the remaining fill is entirely at risk, clamped to what is there');
  assert.match(html, /0\.60M over/);
  assert.doesNotMatch(html, /(width|left):-|aria-valuenow="-/, 'an overrun never renders as a negative width or figure');
  // Every overrun draws the same clamped geometry, so the colour is the only thing that separates it
  // from a window that merely gets tight; the track carries it too, for the case with no fill left.
  assert.match(html, /role="meter"[^>]*class="[^"]*bg-destructive\/25/);
  assert.match(html, /var\(--destructive\)[^>]*style="left:0%;width:16%"/, 'the at-risk hatch turns destructive, not a fainter primary');
  assert.doesNotMatch(render({ used: 2.14, projected: 3.16, limit: 5 }), /destructive/, 'a forecast that lands inside the limit stays calm');
});

test('an exhausted allowance draws an empty bar and never a negative one', () => {
  assert.match(render({ used: 5, limit: 5 }), /aria-label="0\.00M of 5\.00M left"/);
  const past = render({ used: 6, limit: 5 });
  assert.match(past, /aria-valuenow="0"/);
  assert.match(past, /style="width:0%"/);
  assert.doesNotMatch(past, /width:-/);
});

test('an untouched allowance draws a full bar', () => {
  const html = render({ used: 0, limit: 5 });
  assert.match(html, /aria-valuenow="5"/);
  assert.match(html, /style="width:100%"/);
});

test('the branches either side of the fill: no limit, no forecast, and a forecast that spends nothing', () => {
  // Both divisions are guarded, not just the first: `used === projected` is the case that leaks NaN
  // rather than an Infinity the clamp swallows, so it reaches the DOM as `width:NaN%`.
  const zero = render({ used: 0, projected: 0, limit: 0 });
  assert.doesNotMatch(zero, /NaN/, 'a zero limit divides in two places, so it is guarded in two places');
  assert.doesNotMatch(render({ used: 2, projected: 4, limit: 0 }), /NaN/);

  assert.doesNotMatch(render({ used: 2, limit: 5 }), /repeating-linear-gradient/, 'no forecast, no hatched slice');
  // A projection under what is already used cannot un-spend it: the at-risk slice floors at nothing.
  const backwards = render({ used: 3, projected: 2, limit: 5 });
  assert.match(backwards, /bg-primary[^>]*style="width:40%"/, 'the whole remainder survives');
  assert.match(backwards, /style="left:40%;width:0%"/);
  assert.doesNotMatch(backwards, /width:-/);
});

test('the scale under the bar is decoration: it repeats the label rather than adding to it', () => {
  const html = render({ used: 2.14, projected: 3.16, limit: 5 });
  assert.match(html, /aria-hidden[^>]*>\s*<span>0<\/span>/, 'the bare endpoints have no referent of their own');
  assert.match(html, /1\.84M left at reset/, 'and they stay visible');
});
