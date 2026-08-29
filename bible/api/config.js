// 성경 사이트 – 브라우저에 넘겨줄 공개 설정 (Google OAuth 클라이언트 ID)
// 클라이언트 ID는 비밀이 아니에요(모든 구글 로그인 페이지의 JS에 그대로 노출됨).
// Vercel 프로젝트 환경변수 GOOGLE_CLIENT_ID 하나만 설정하면 프론트가 여기서 받아가요.

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.status(200).json({ clientId: process.env.GOOGLE_CLIENT_ID || '' });
};
