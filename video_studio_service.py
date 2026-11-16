import os
import re
import json
import glob
import subprocess
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
import httpx

SERIES_DIR = "/Users/duandongyi/Desktop/history_wild_series"
JY_DRAFT_DIR = "/Users/duandongyi/Movies/JianyingPro/User Data/Projects/com.lveditor.draft"
CHATCUT_MCP_PATH = "/Users/duandongyi/Library/Application Support/ChatCut/chatcut-mcp"
LEMO_DIR = "/Users/duandongyi/plugins/lemo-opuscar"
GIF_FACTORY_DIR = "/Users/duandongyi/plugins/gif-factory"

router = APIRouter(prefix="/api/video_studio", tags=["Video Studio"])

def get_engine_statuses():
    statuses = {
        "chatcut_mcp": {"name": "ChatCut Desktop MCP", "status": "offline", "detail": "64项视频工具"},
        "image_pool": {"name": "生图工坊账号池", "status": "offline", "detail": "Bluxe 370风格"},
        "lemo_opuscar": {"name": "Lemo-Opuscar 代码电影", "status": "offline", "detail": "99种纯代码风格"},
        "gif_factory": {"name": "GIF工厂片头/签名", "status": "offline", "detail": "50+电影片头字形"},
        "jianying": {"name": "剪映专业版", "status": "offline", "detail": "原生草稿自动注入"},
        "channels_cdp": {"name": "微信视频号通道", "status": "offline", "detail": "草稿箱自动化"},
    }
    
    # 1. ChatCut MCP
    if os.path.exists(CHATCUT_MCP_PATH):
        statuses["chatcut_mcp"]["status"] = "online"
        statuses["chatcut_mcp"]["detail"] = "64项专业剪辑工具就绪"
        
    # 2. Lemo-Opuscar
    if os.path.exists(LEMO_DIR):
        statuses["lemo_opuscar"]["status"] = "online"
        statuses["lemo_opuscar"]["detail"] = "99种纯代码影片风格"
        
    # 3. GIF Factory
    if os.path.exists(GIF_FACTORY_DIR):
        statuses["gif_factory"]["status"] = "online"
        statuses["gif_factory"]["detail"] = "电影片头 & 动态签名就绪"
        
    # 4. JianYing
    if os.path.exists(JY_DRAFT_DIR):
        statuses["jianying"]["status"] = "online"
        statuses["jianying"]["detail"] = "草稿目录连接正常"
        
    # 5. Image Pool (async checked or quick sync)
    try:
        with httpx.Client(timeout=1.0) as client:
            resp = client.get("http://127.0.0.1:8092/api/pool/panel")
            if resp.status_code == 200:
                data = resp.json()
                statuses["image_pool"]["status"] = "online"
                statuses["image_pool"]["detail"] = f"{data.get('total', 20)}号在线 · 配额{data.get('quota', 340)}"
    except Exception:
        pass
        
    # 6. Channels CDP
    try:
        with httpx.Client(timeout=1.0) as client:
            resp = client.get("http://127.0.0.1:9222/json/version")
            if resp.status_code == 200:
                statuses["channels_cdp"]["status"] = "online"
                statuses["channels_cdp"]["detail"] = "Chrome 9222 CDP 连接正常"
    except Exception:
        pass

    return statuses

@router.get("/status")
def api_status():
    return {"statuses": get_engine_statuses()}

@router.get("/projects")
def api_list_projects():
    if not os.path.exists(SERIES_DIR):
        return {"projects": []}
        
    projects = []
    subdirs = [d for d in os.listdir(SERIES_DIR) if os.path.isdir(os.path.join(SERIES_DIR, d))]
    
    # Sort with natural sort on episode number
    def sort_key(name):
        m = re.match(r"^(\d+)", name)
        return int(m.group(1)) if m else -1
        
    subdirs.sort(key=sort_key, reverse=True)
    
    for folder in subdirs:
        folder_path = os.path.join(SERIES_DIR, folder)
        m = re.match(r"^(\d+)_(.+)$", folder)
        ep_num = m.group(1) if m else "0"
        slug = m.group(2) if m else folder
        
        # Human title mapping
        human_title = slug.replace("_", " ").title()
        if "pidingjun_shang" in slug:
            human_title = "皮定均中原突围上"
        elif "pidingjun_xia" in slug:
            human_title = "皮定均中原突围下"
        elif "yan_shifan" in slug:
            human_title = "严世蕃富贵穷途"
        elif "jia_sidao" in slug:
            human_title = "贾似道蟋蟀宰相"
        elif "shi_chong" in slug:
            human_title = "石崇金谷繁华梦"
        # Check shots_data.json
        shots_json_path = os.path.join(folder_path, "shots_data.json")
        shots_count = 0
        if os.path.exists(shots_json_path):
            try:
                with open(shots_json_path, "r", encoding="utf-8") as sjf:
                    sjd = json.load(sjf)
                    human_title = sjd.get("short_title") or sjd.get("title") or human_title
                    shots_count = len(sjd.get("shots", []))
            except Exception:
                pass

        # Check files
        video_candidates = [
            os.path.join(folder_path, "成片预览.mp4"),
            os.path.join(folder_path, f"{folder}.mp4"),
            os.path.join(folder_path, "preview.mp4")
        ]
        video_file = next((f for f in video_candidates if os.path.exists(f)), None)
        
        video_size_mb = 0
        mtime_str = ""
        if video_file:
            stat = os.stat(video_file)
            video_size_mb = round(stat.st_size / (1024 * 1024), 2)
            import datetime
            mtime_str = datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M")
            
        audio_files = glob.glob(os.path.join(folder_path, "*.mp3")) + glob.glob(os.path.join(folder_path, "audio", "*.mp3"))
        srt_files = glob.glob(os.path.join(folder_path, "*.srt")) + glob.glob(os.path.join(folder_path, "audio", "*.srt"))
        image_files = glob.glob(os.path.join(folder_path, "*.jpg")) + glob.glob(os.path.join(folder_path, "*.png")) + glob.glob(os.path.join(folder_path, "images", "*.png"))
        
        # Check JianYing draft
        draft_match = False
        if os.path.exists(JY_DRAFT_DIR):
            for d in os.listdir(JY_DRAFT_DIR):
                if human_title in d or folder in d or (slug in d) or ("有庆" in d and "30" in folder):
                    draft_match = True
                    break
                    
        projects.append({
            "id": folder,
            "episode": int(ep_num) if ep_num.isdigit() else 0,
            "title": human_title,
            "folder": folder_path,
            "has_video": video_file is not None,
            "video_path": video_file,
            "video_size_mb": video_size_mb,
            "mtime": mtime_str,
            "audio_count": len(audio_files),
            "srt_count": len(srt_files),
            "shots_count": len(image_files),
            "has_jianying_draft": draft_match
        })
        
    return {"projects": projects}

@router.get("/project/{project_id}")
def api_get_project(project_id: str):
    folder_path = os.path.join(SERIES_DIR, project_id)
    if not os.path.exists(folder_path):
        raise HTTPException(404, "Project not found")
        
    video_file = next((f for f in [
        os.path.join(folder_path, "成片预览.mp4"),
        os.path.join(folder_path, f"{project_id}.mp4"),
        os.path.join(folder_path, "preview.mp4")
    ] if os.path.exists(f)), None)
    
    # Read SRT if available
    srt_file = next((f for f in glob.glob(os.path.join(folder_path, "*.srt"))), None)
    srt_content = ""
    if srt_file and os.path.exists(srt_file):
        try:
            with open(srt_file, "r", encoding="utf-8", errors="ignore") as f:
                srt_content = f.read()
        except Exception:
            pass
            
    # Read script or shots py if exists
    shots_file = next((f for f in glob.glob(os.path.join(folder_path, "*shots*.json")) + glob.glob(os.path.join(folder_path, "*script*.txt"))), None)
    script_text = ""
    if shots_file and os.path.exists(shots_file):
        try:
            with open(shots_file, "r", encoding="utf-8", errors="ignore") as f:
                script_text = f.read()
        except Exception:
            pass
            
    images = []
    for img in sorted(glob.glob(os.path.join(folder_path, "*.jpg")) + glob.glob(os.path.join(folder_path, "*.png"))):
        images.append({
            "name": os.path.basename(img),
            "path": img,
            "size": round(os.path.getsize(img) / 1024, 1)
        })

    return {
        "id": project_id,
        "folder": folder_path,
        "video_path": video_file,
        "has_video": video_file is not None,
        "srt_content": srt_content,
        "script_text": script_text,
        "images": images
    }

@router.get("/stream")
def api_stream_video(path: str, request: Request):
    if not os.path.exists(path) or not path.endswith(".mp4"):
        raise HTTPException(404, "Video file not found")
        
    file_size = os.path.getsize(path)
    range_header = request.headers.get("range")
    
    if range_header:
        # e.g. "bytes=0-1000"
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else file_size - 1
            length = end - start + 1
            
            def iter_chunk():
                with open(path, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk_size = min(64 * 1024, remaining)
                        data = f.read(chunk_size)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data
                        
            headers = {
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(length),
                "Content-Type": "video/mp4",
            }
            return StreamingResponse(iter_chunk(), status_code=206, headers=headers)
            
    def iter_full():
        with open(path, "rb") as f:
            while chunk := f.read(128 * 1024):
                yield chunk
                
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(file_size),
        "Content-Type": "video/mp4",
    }
    return StreamingResponse(iter_full(), status_code=200, headers=headers)

@router.post("/action/open_jianying")
def api_open_jianying():
    try:
        subprocess.run(["open", "-a", "JianyingPro"], check=False)
        return {"success": True, "message": "已在 macOS 中启动剪映专业版"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@router.post("/action/open_chatcut")
def api_open_chatcut():
    try:
        subprocess.run(["open", "-a", "ChatCut"], check=False)
        return {"success": True, "message": "已启动 ChatCut Desktop"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@router.post("/action/open_finder")
def api_open_finder(data: dict):
    target = data.get("path") or SERIES_DIR
    try:
        subprocess.run(["open", "-R" if os.path.isfile(target) else "", target], check=False)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

@router.get("/styles_catalog")
def api_styles_catalog():
    # Return Lemo styles and GIF factory lettering styles
    lemo_styles = [
        {"id": "satellite-briefing", "name": "Satellite Briefing 卫星战术简报", "category": "战役推演", "desc": "高空卫星扫描与战局动态推演"},
        {"id": "tactical-map", "name": "Tactical Map 战役沙盘", "category": "军事历史", "desc": "军事地形等高线与行军箭头动画"},
        {"id": "exploded-teardown", "name": "Exploded Teardown 立体机械拆解", "category": "原理科普", "desc": "零件分层爆炸与精准咬合动画"},
        {"id": "watercolor-brush", "name": "Watercolor Brush 水彩笔刷", "category": "艺术风格", "desc": "古典水彩渗墨与唯美人物史诗"},
        {"id": "impasto-oil", "name": "Impasto Oil Painting 油画厚涂", "category": "艺术风格", "desc": "梵高式厚涂肌理与历史厚重感"},
        {"id": "blueprint-cad", "name": "Blueprint CAD 科技蓝图", "category": "工业科技", "desc": "网格坐标、标尺测算与工程蓝图动效"}
    ]
    
    lettering_styles = [
        {"id": "xingkai-splash", "name": "行楷破屏水墨飞溅", "category": "古典国风", "preview": "大开大阖行楷书写，墨滴喷薄爆裂"},
        {"id": "kuangcao-gold", "name": "狂草鎏金浮雕", "category": "霸气史诗", "preview": "纯金流光划破黑夜，重器威严"},
        {"id": "hanli-stone", "name": "汉隶金石雕琢", "category": "厚重史书", "preview": "岩石刀刻斧凿，历史沧桑"},
        {"id": "song-seal", "name": "宋体朱砂印章", "category": "雅致文人", "preview": "瘦金/宋体朱红盖印，风雅无双"},
        {"id": "blockbuster-3d", "name": "好莱坞大片金属3D", "category": "现代电影", "preview": "暗光金属倒角，粒子穿梭爆燃"}
    ]
    
    return {
        "lemo_styles": lemo_styles,
        "lettering_styles": lettering_styles
    }
