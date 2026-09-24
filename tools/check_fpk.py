"""核验 .fpk 里的生命周期脚本是否带可执行权限。

只读检查，不修改。权限不对就以退出码 1 结束，让打包脚本停下来报错。
"""

import sys
import tarfile

NEEDED = [
    "cmd/main",
    "cmd/install_init",
    "cmd/install_callback",
    "cmd/upgrade_init",
    "cmd/upgrade_callback",
    "cmd/uninstall_init",
    "cmd/uninstall_callback",
    "cmd/config_init",
    "cmd/config_callback",
]


def check(path):
    try:
        with tarfile.open(path, "r:gz") as tar:
            modes = {m.name: m.mode for m in tar.getmembers()}
    except Exception as error:
        print("读不了这个包：" + str(error))
        return 1

    missing = [n for n in NEEDED if n not in modes]
    if missing:
        print("包里缺少脚本：" + "、".join(missing))
        return 1

    bad = [n for n in NEEDED if not modes[n] & 0o111]
    if bad:
        print("这些脚本没有执行权限：" + "、".join(bad))
        return 1

    print("核验通过，%d 个脚本都带执行权限。" % len(NEEDED))
    return 0


if __name__ == "__main__":
    sys.exit(check(sys.argv[1] if len(sys.argv) > 1 else "diary.fpk"))
