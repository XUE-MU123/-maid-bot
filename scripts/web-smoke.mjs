// Static-only smoke check. Supply the isolated preview URL explicitly; never reads private APIs.
const raw = process.env.PANEL_ORIGIN;
if (!raw) throw new Error('Set PANEL_ORIGIN to the static preview origin explicitly.');
const origin = new URL(raw).origin;
const page = await fetch(`${origin}/`);
if (!page.ok) throw new Error(`Static entry HTTP ${page.status}`);
const html = await page.text();
const script = html.match(/src="(\/assets\/[^" ]+\.js)"/i)?.[1];
const style = html.match(/href="(\/assets\/[^" ]+\.css)"/i)?.[1];
if (!script || !style || !html.includes('id="root"')) throw new Error('Missing React entry or assets');
for (const asset of [script, style]) {
  const response = await fetch(`${origin}${asset}`);
  if (!response.ok) throw new Error(`Asset HTTP ${response.status}`);
}
console.log('Static entry and assets verified; private APIs were not requested.');
