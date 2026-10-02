# -*- coding: utf-8 -*-
import re, collections
src = open('德州扑克.html', encoding='utf-8').read()
lines = src.split('\n')

# 所有 localStorage 使用（含变量形式的键名）
allkeys = re.findall(r"(?:getItem|setItem|removeItem)\(\s*([A-Za-z_$][\w$]*)", src)
print('getItem/setItem 直接字面量参数出现次数:', len(allkeys))
# 键名常量定义
for m in re.finditer(r"(?:const|let|var)\s+([A-Z_]*KEY[A-Z_]*)\s*=\s*['\"]([^'\"]+)['\"]", src):
    print('  常量', m.group(1), '=', m.group(2))
print()
# BACKUP_KEYS 完整块
i = src.find('BACKUP_KEYS')
print(src[i:i+700].split('\n\n')[0][:700])
