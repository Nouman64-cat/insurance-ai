import re

with open("frontend/components/Sidebar.tsx", "r") as f:
    content = f.read()

target = """            <button 
              title="Logout"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                localStorage.clear();
                window.location.href = "/login";
              }}
              className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded-lg transition-colors cursor-pointer flex-shrink-0"
            >"""

replacement = """            <button 
              type="button"
              title="Logout"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                localStorage.clear();
                window.location.replace("/login");
              }}
              className="text-slate-400 hover:text-red-500 hover:bg-red-50 p-1.5 rounded-lg transition-colors cursor-pointer flex-shrink-0 relative z-50"
            >"""

if target in content:
    with open("frontend/components/Sidebar.tsx", "w") as f:
        f.write(content.replace(target, replacement))
    print("PATCHED")
else:
    print("NOT FOUND")
