import sys
import re
import urllib.request
import urllib.parse
import http.cookiejar
from pathlib import Path

FILE_ID = "1-5BU3Bavs6SGJpaByua_FhDuUJGoo-iS"
DEST = Path("data/models/adcd/ADCD-Net_exp_data.zip")

def download():
    DEST.parent.mkdir(parents=True, exist_ok=True)
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    
    url = f"https://drive.google.com/uc?export=download&id={FILE_ID}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    
    resp = opener.open(req)
    html = resp.read().decode("utf-8", errors="ignore")
    
    action_match = re.search(r'action="([^"]+)"', html)
    if not action_match:
        print("No action found in html!")
        return False
        
    action_url = action_match.group(1)
    
    # Extract all input fields
    inputs = re.findall(r'<input[^>]+name="([^"]+)"[^>]+value="([^"]+)"', html)
    # Also handle value before name
    inputs += re.findall(r'<input[^>]+value="([^"]+)"[^>]+name="([^"]+)"', html)
    # Filter and format params
    params = {}
    for item in re.finditer(r'<input\s+([^>]+)>', html):
        attrs = dict(re.findall(r'(\w+)="([^"]+)"', item.group(1)))
        if "name" in attrs and "value" in attrs:
            params[attrs["name"]] = attrs["value"]
            
    print(f"Action: {action_url}")
    print(f"Params: {params}")
    
    full_url = f"{action_url}?{urllib.parse.urlencode(params)}"
    print(f"Downloading {DEST.name} from {full_url}...")
    
    req2 = urllib.request.Request(full_url, headers={"User-Agent": "Mozilla/5.0"})
    with opener.open(req2) as in_f, open(DEST, "wb") as out_f:
        total = int(in_f.headers.get("Content-Length", 0))
        downloaded = 0
        chunk_size = 1024 * 1024 * 4  # 4MB
        while True:
            chunk = in_f.read(chunk_size)
            if not chunk:
                break
            out_f.write(chunk)
            downloaded += len(chunk)
            if total > 0:
                pct = downloaded / total * 100
                print(f"  {downloaded / 1e6:.1f} MB / {total / 1e6:.1f} MB ({pct:.1f}%)", end="\r", flush=True)
            else:
                print(f"  {downloaded / 1e6:.1f} MB", end="\r", flush=True)
    print(f"\nDownload complete: {DEST} ({DEST.stat().st_size / 1e6:.1f} MB)")
    return True

if __name__ == "__main__":
    download()
