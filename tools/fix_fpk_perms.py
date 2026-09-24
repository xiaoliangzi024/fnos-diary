"""给 .fpk 里的 cmd/ 脚本补上可执行权限。

在 Windows 上用 fnpack 打包会丢掉 exec 位（cmd/* 变成 0666），
装到飞牛后生命周期脚本无法执行。这里把外层 tar 重新写一遍，
只改权限，不动内容。
"""

import os
import sys
import tarfile

EXEC = 0o755
DATA = 0o644


def fix(path):
    tmp = path + ".tmp"
    changed = []
    with tarfile.open(path, "r:gz") as src, tarfile.open(tmp, "w:gz", compresslevel=9) as dst:
        for member in src:
            if member.name.startswith("cmd/") and member.isfile():
                member.mode = EXEC
                changed.append(member.name)
            elif member.name.endswith("/") or member.isdir():
                member.mode = 0o777
            if member.name in ("manifest", "config/privilege", "config/resource"):
                member.mode = DATA
            dst.addfile(member, src.extractfile(member) if member.isfile() else None)
    os.replace(tmp, path)
    return changed


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "diary.fpk"
    names = fix(target)
    print("已补执行权限：" + ("、".join(names) if names else "无（可能已修过）"))
