"""Builds public/scalehaus-preview.html: one self contained file with styles, scripts and images inside.
Use it to preview or share the site without a server. The live site uses public/index.html."""
import base64, json, os, re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public')
html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
css = open(os.path.join(ROOT, 'assets/styles.css'), encoding='utf-8').read()
js = open(os.path.join(ROOT, 'assets/app.js'), encoding='utf-8').read()

def data_uri(rel):
    ext = rel.rsplit('.', 1)[1].lower()
    mime = {'webp': 'image/webp', 'jpg': 'image/jpeg', 'png': 'image/png', 'svg': 'image/svg+xml'}[ext]
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return f'data:{mime};base64,' + base64.b64encode(f.read()).decode()

assets = {}
for folder in ['assets/img/work', 'assets/img']:
    for name in sorted(os.listdir(os.path.join(ROOT, folder))):
        if name.endswith('.webp'):
            assets[f'{folder}/{name}'] = data_uri(f'{folder}/{name}')

html = html.replace('<link rel="stylesheet" href="assets/styles.css">', f'<style>\n{css}\n</style>')
html = re.sub(r'<script type="importmap">.*?</script>\n', '', html, flags=re.S)
html = html.replace('<script type="module" src="assets/viewer.js"></script>\n', '')
html = html.replace('href="assets/img/favicon.svg"', f'href="{data_uri("assets/img/favicon.svg")}"')
html = html.replace('src="assets/img/portal-s3.webp"', f'src="{assets["assets/img/portal-s3.webp"]}"')
html = html.replace(
    '<script src="assets/app.js"></script>',
    '<script>window.__ASSETS = ' + json.dumps(assets) + ';</script>\n<script>\n' + js + '\nwindow.viewerFallback && window.viewerFallback();\n</script>'
)
out = os.path.join(ROOT, 'scalehaus-preview.html')
open(out, 'w', encoding='utf-8').write(html)
print(out, round(os.path.getsize(out) / 1e6, 1), 'MB')
