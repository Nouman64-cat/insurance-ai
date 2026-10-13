import axios from "axios";
import { sessionExpired } from "@/lib/sso";
export const api=axios.create({baseURL:(process.env.NEXT_PUBLIC_API_URL||"http://localhost:8010")+"/customer-service/v1",timeout:15000});
api.interceptors.request.use(c=>{c.headers.Authorization="Bearer "+localStorage.getItem("jwt_token");return c;});
api.interceptors.response.use(r=>r,e=>{if(e.response?.status===401)sessionExpired();return Promise.reject(new Error(e.response?.data?.detail||"Customer Service is unavailable. Try again."));});
