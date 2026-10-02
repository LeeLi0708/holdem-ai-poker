# -*- coding: utf-8 -*-
import re, collections
src = open('德州扑克.html', encoding='utf-8').read()
# 定义过的 id（HTML 静态 + JS 里 innerHTML 模板）
defined = set(re.findall(r'\bid\s*=\s*["\']([A-Za-z][\w-]*)["\']', src))
# 引用的 id
used = set(re.findall(r'getElementById\(\s*["\']([A-Za-z][\w-]*)["\']', src))
used |= set(re.findall(r'\$\(\s*["\']#([A-Za-z][\w-]*)["\']', src))
used |= set(re.findall(r"querySelector\(\s*['\"]#([A-Za-z][\w-]*)['\"]", src))
print('定义的 id 数', len(defined))
print('引用的 id 数', len(used))
miss = sorted(used - defined)
print('\n== 引用但未定义（%d）==' % len(miss))
for x in miss: print('  #'+x, '出现', len(re.findall(r'["\']#'+re.escape(x)+r'["\']|getElementById\(\s*["\']'+re.escape(x)+r'["\']', src)), '次')

# 面板/弹层容器
print('\n== 主要弹层（overlay/modal/panel 类）==')
for m in re.finditer(r'<div[^>]*class=["\'][^"\']*(?:overlay|modal|panel|sheet|drawer)[^"\']*["\'][^>]*>', src):
    print(' ', m.group(0)[:160])
