import re

with open("frontend/components/CopilotInterface.tsx", "r") as f:
    content = f.read()

target = """                    {messages.map((msg) => (
                      <div key={msg.id} className="w-full px-4 py-5 hover:bg-slate-50/50 transition-colors">
                        <div className="max-w-3xl mx-auto flex gap-4 md:gap-6">
                           <div className="flex-shrink-0 mt-1">
                             {msg.role === "user" ? (
                               <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white flex items-center justify-center text-sm font-bold shadow-md">
                                 U
                               </div>
                             ) : (
                               <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-[0_0_12px_rgba(99,102,241,0.3)] flex items-center justify-center p-1.5 ring-2 ring-white">
                                 <img src="/rizvi.png" alt="Agent" className="w-full h-full object-contain brightness-0 invert" />
                               </div>
                             )}
                           </div>
                           <div className="flex-1 min-w-0">
                             <div className="font-bold text-slate-800 mb-1 text-[15px]">
                               {msg.role === "user" ? "You" : "Rizviz"}
                             </div>
                             <div className={`prose prose-slate max-w-none text-[16px] leading-relaxed break-words text-slate-700`}>
                               {msg.role === "user" ? (
                                 <div className="whitespace-pre-wrap">{msg.text}</div>
                               ) : (
                                 <div className="copilot-markdown">
                                   <ReactMarkdown>{msg.text}</ReactMarkdown>
                                 </div>
                               )}
                             </div>
                             
                             {/* Quick Actions */}
                             {msg.quickActions && msg.quickActions.length > 0 && (
                               <div className="flex flex-wrap gap-2 mt-4">
                                 {msg.quickActions.map((action, idx) => (
                                   <button
                                     key={`${action.actionType}-${action.label}-${idx}`}
                                     onClick={() => handleQuickAction(action)}
                                     className="px-3 py-1.5 text-xs font-medium rounded-full bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-600 transition-colors flex items-center gap-1.5"
                                   >
                                     {action.label}
                                   </button>
                                 ))}
                               </div>
                             )}
                           </div>
                        </div>
                      </div>
                    ))}"""

replacement = """                    {messages.map((msg) => (
                      <div key={msg.id} className="w-full px-4 py-4 md:py-6">
                        <div className={`max-w-3xl mx-auto flex gap-4 md:gap-5 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                          
                          {/* Avatar (only for Agent) */}
                          {msg.role !== "user" && (
                            <div className="flex-shrink-0 mt-1">
                              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-[0_0_12px_rgba(99,102,241,0.3)] flex items-center justify-center p-1.5 ring-2 ring-white">
                                <img src="/rizvi.png" alt="Agent" className="w-full h-full object-contain brightness-0 invert" />
                              </div>
                            </div>
                          )}

                          <div className={`flex-1 min-w-0 flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}>
                            {msg.role !== "user" && (
                              <div className="font-bold text-slate-800 mb-1 text-[15px]">Rizviz Copilot</div>
                            )}
                            
                            <div className={`${
                              msg.role === "user" 
                                ? "bg-slate-100 text-slate-800 border border-slate-200/60 px-5 py-3.5 rounded-[24px] rounded-tr-sm shadow-sm max-w-[85%] text-[15px] leading-relaxed whitespace-pre-wrap"
                                : "prose prose-slate max-w-none text-[15px] leading-relaxed break-words text-slate-700 w-full"
                            }`}>
                              {msg.role === "user" ? (
                                msg.text
                              ) : (
                                <div className="copilot-markdown">
                                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                                </div>
                              )}
                            </div>
                            
                            {/* Quick Actions */}
                            {msg.quickActions && msg.quickActions.length > 0 && (
                              <div className={`flex flex-wrap gap-2 mt-4 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                                {msg.quickActions.map((action, idx) => (
                                  <button
                                    key={`${action.actionType}-${action.label}-${idx}`}
                                    onClick={() => handleQuickAction(action)}
                                    className="px-3 py-1.5 text-xs font-semibold rounded-full bg-white border border-slate-200 hover:bg-slate-50 hover:border-indigo-200 hover:text-indigo-700 shadow-sm transition-all flex items-center gap-1.5"
                                  >
                                    {action.label}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}"""

new_content = content.replace(target, replacement)
if new_content == content:
    print("FAILED TO REPLACE")
else:
    with open("frontend/components/CopilotInterface.tsx", "w") as f:
        f.write(new_content)
    print("SUCCESSFULLY REPLACED")

