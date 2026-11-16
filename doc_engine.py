import re
import uuid
import datetime
from typing import List, Dict, Any, Tuple

def auto_close_blocks(text: str) -> str:
    # Check if there is an unclosed <<<FILE or <<<EDIT
    file_open = re.search(r'^[ \t]*<<<(FILE|EDIT)\s+path=["\']([^"\r\n]+)["\']\s*>>>', text, re.M)
    if file_open:
        remaining = text[file_open.end():]
        if not re.search(r'^[ \t]*<<<END>>>', remaining, re.M):
            # Check if there is a '## 📋' or diagnostic section outside
            diag_m = re.search(r'\n(?=##\s+📋|##\s+📌|\n##\s+🛡️|##\s+七步)', remaining)
            if diag_m:
                split_pos = file_open.end() + diag_m.start()
                text = text[:split_pos] + '\n<<<END>>>\n' + text[split_pos:]
            else:
                text = text.rstrip() + '\n<<<END>>>\n'
    return text

def parse_model_reply(text: str) -> Dict[str, Any]:
    text = auto_close_blocks(text)
    raw_text = text
    operations = []
    errors = []
    
    # Pattern for FILE block
    file_pattern = re.compile(r'<<<FILE\s+path=["\'](.*?)["\']\s*>>>(.*?)<<<END>>>', re.S)
    # Pattern for EDIT block
    edit_pattern = re.compile(r'<<<EDIT\s+path=["\'](.*?)["\']\s*>>>\s*<<<OLD>>>(.*?)<<<NEW>>>(.*?)<<<END>>>', re.S)
    
    # Extract all blocks with positions
    matches = []
    for m in file_pattern.finditer(text):
        matches.append((m.start(), m.end(), "file", m.group(1).strip(), m.group(2).strip(), None))
    for m in edit_pattern.finditer(text):
        matches.append((m.start(), m.end(), "edit", m.group(1).strip(), m.group(3).strip(), m.group(2).strip()))
        
    # Sort by appearance order
    matches.sort(key=lambda x: x[0])
    
    clean_text = text
    # Remove matched blocks from clean_text (going backwards to keep indices)
    for m in sorted(matches, key=lambda x: x[0], reverse=True):
        clean_text = clean_text[:m[0]] + clean_text[m[1]:]
    clean_text = clean_text.strip()
    
    for idx, (_, _, kind, path, content, old_content) in enumerate(matches):
        if kind == "file":
            operations.append({
                "kind": "file",
                "path": path,
                "text": content,
                "operationIndex": idx
            })
        elif kind == "edit":
            operations.append({
                "kind": "edit",
                "path": path,
                "before": old_content,
                "after": content,
                "operationIndex": idx
            })
            
    return {
        "rawText": raw_text,
        "text": clean_text if clean_text else raw_text,
        "operations": operations,
        "errors": errors
    }

def apply_operations(drafts: List[Dict[str, Any]], operations: List[Dict[str, Any]]) -> Dict[str, Any]:
    working = [dict(d) for d in drafts]
    changes = []
    errors = []
    now = datetime.datetime.now().isoformat()
    
    for op in operations:
        kind = op.get("kind")
        path = op.get("path", "")
        # Clean path
        path = path.replace("\\", "/").strip()
        if not path.endswith(".md"):
            path += ".md"
        title = path.split("/")[-1].replace(".md", "")
        folder_id = "/".join(path.split("/")[:-1]) or "二创稿"
        
        # Find existing draft
        existing = next((d for d in working if d.get("path") == path or d.get("title") == title), None)
        
        if kind == "file":
            new_text = op.get("text", "")
            if existing:
                before = existing.get("text", "")
                version = existing.get("version", 1) + 1
                existing["text"] = new_text
                existing["version"] = version
                existing["updatedAt"] = now
                existing.setdefault("versions", []).append({
                    "version": version,
                    "text": new_text,
                    "kind": "file",
                    "createdAt": now
                })
                draft_id = existing.get("id")
            else:
                draft_id = f"doc-{uuid.uuid4().hex[:12]}"
                before = ""
                version = 1
                existing = {
                    "id": draft_id,
                    "title": title,
                    "folderId": folder_id,
                    "path": path,
                    "text": new_text,
                    "version": 1,
                    "versions": [{
                        "version": 1,
                        "text": new_text,
                        "kind": "file",
                        "createdAt": now
                    }],
                    "updatedAt": now
                }
                working.append(existing)
                
            changes.append({
                "operationIndex": op.get("operationIndex", len(changes)),
                "kind": "file",
                "path": path,
                "title": title,
                "draftId": draft_id,
                "before": before,
                "after": new_text,
                "version": version,
                "status": "applied",
                "added": len(new_text.splitlines()),
                "removed": len(before.splitlines()) if before else 0
            })
            
        elif kind == "edit":
            if not existing:
                errors.append({"path": path, "reason": "未找到需要局部修改的稿件"})
                continue
            before = existing.get("text", "")
            old_piece = op.get("before", "")
            new_piece = op.get("after", "")
            
            if old_piece not in before:
                errors.append({"path": path, "reason": "未在原稿件中定位到需要替换的原文段落"})
                continue
                
            new_text = before.replace(old_piece, new_piece, 1)
            version = existing.get("version", 1) + 1
            existing["text"] = new_text
            existing["version"] = version
            existing["updatedAt"] = now
            existing.setdefault("versions", []).append({
                "version": version,
                "text": new_text,
                "kind": "edit",
                "createdAt": now
            })
            changes.append({
                "operationIndex": op.get("operationIndex", len(changes)),
                "kind": "edit",
                "path": path,
                "title": title,
                "draftId": existing.get("id"),
                "before": before,
                "after": new_text,
                "version": version,
                "status": "applied",
                "added": len(new_piece.splitlines()),
                "removed": len(old_piece.splitlines())
            })
            
    return {
        "ok": len(errors) == 0,
        "drafts": working,
        "changes": changes,
        "errors": errors
    }
