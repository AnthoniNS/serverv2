// app.js
const http = require('http');

const server = http.createServer((req, res) => {
    // Opcional: você pode ou não responder requisições
    // Mas como o foco é só o console, ignoramos ou damos uma resposta mínima
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Servidor rodando');
});

server.listen(5000, () => {
    // Isso aparece NO CONSOLE quando o servidor inicia
    console.log('Hello World');
});