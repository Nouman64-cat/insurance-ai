export default function Home() {
  const portal = (process.env.PORTAL_URL || "http://localhost:3000").replace(/\/$/, "");
  return <main><h1>Document Intelligence</h1><p>This workspace is now available to signed-in tenant Admins in the main portal.</p><a href={`${portal}/admin/document-intelligence`}>Open Admin Document Intelligence</a></main>;
}
