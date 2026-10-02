# -*- coding: utf-8 -*-
import re
src = open('德州扑克.html', encoding='utf-8').read()
lines = src.split('\n')
body = '\n'.join(lines[992:1656])

# 顶栏与主要按钮
print('== 顶栏/工具条按钮（body 段）==')
for m in re.finditer(r'<button[^>]*>(.*?)</button>', body, re.S):
    t = re.sub(r'<[^>]+>','',m.group(1)).strip()
    idm = re.search(r'id="([^"]+)"', m.group(0))
    if t:
        print(f'  [{idm.group(1) if idm else "":22s}] {t[:44]}')

print('\n== 面板标题 / 页签（全文 title/tab 类）==')
for m in re.finditer(r'<(?:h[123]|div)[^>]*class=["\'][^"\']*(?:panel-title|modal-title|tab|seg-btn|hdr)[^"\']*["\'][^>]*>(.*?)<', src, re.S):
    t = re.sub(r'<[^>]+>','',m.group(1)).strip()
    if t: print('  ', t[:60])
