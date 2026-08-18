# backend/download_embed.py
import os

from modelscope import snapshot_download

# 1. 设定目标目录 (直接下载到项目里的 models 文件夹)
# 这样下载完就在正确的位置，不用手动复制粘贴了
target_dir = os.path.join(os.getcwd(), "models", "bge-large-zh-v1.5")

print("🚀 正在通过 ModelScope 高速下载 Embedding 模型...")
print(f"📂 目标路径: {target_dir}")

# 2. 开始下载
try:
    # model_id 是魔搭社区对应的 ID
    model_path = snapshot_download("AI-ModelScope/bge-large-zh-v1.5", local_dir=target_dir)
    print("\n✅ 下载成功！")
    print(f"文件已保存在: {model_path}")

    # 检查一下关键文件是否存在
    if os.path.exists(os.path.join(target_dir, "model.safetensors")):
        print("🔍 核心文件 model.safetensors 校验存在。")
    else:
        print("⚠️ 警告：未找到 model.safetensors，可能下载不完整。")

except Exception as e:
    print(f"❌ 下载失败: {e}")
