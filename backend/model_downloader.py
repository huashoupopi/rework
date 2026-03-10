# backend/model_downloader.py
from modelscope import snapshot_download

# 1. 仓库 ID
model_id = "unsloth/Qwen3.5-4B-GGUF"

print(f"🚀 正在通过 ModelScope 高速通道下载: {model_id}...")
print("🎯 目标文件: Q4_K_M.gguf (主模型) + mmproj-F16.gguf (视觉模块)...")

# 2. 定义要下载的文件匹配模式 (列表格式)
# 包含 Q4_K_M 主权重，以及 F16 精度的 vision mmproj 文件
target_files = [
    "*Q4_K_M.gguf",
    "*mmproj-F16.gguf"
]

# 3. 开始下载
try:
    local_dir = snapshot_download(
        model_id,
        cache_dir="./models",
        allow_file_pattern=target_files # 传入列表
    )
    print("✅ 下载完成！")
    print(f"📁 文件保存在: {local_dir}")
except Exception as e:
    print(f"❌ 下载出错: {e}")
    print("👉 请检查网络连接或 ModelScope 依赖是否正确安装。")
