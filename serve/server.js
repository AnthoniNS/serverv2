const express = require('express');
const pm2 = require('pm2');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const yaml = require('yaml');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Diretórios base
const BASE_DIR = path.join(__dirname, '..');
const GIT_APP_DIR = path.join(BASE_DIR, 'Projects', 'app');
const GIT_WWW_DIR = path.join(BASE_DIR, 'Projects', 'www');

// Diretórios usados no app
const SITES_ENABLED_DIR = path.join(__dirname, 'caddy', 'sites-enabled');
const DOCKER_PROJECTS_DIR = path.join(BASE_DIR, 'Projects', 'docker');
const GIT_DOCKER_DIR = DOCKER_PROJECTS_DIR;

// Garantir diretórios existem
[SITES_ENABLED_DIR, DOCKER_PROJECTS_DIR, GIT_APP_DIR, GIT_WWW_DIR].forEach(dir => {
  fs.mkdir(dir, { recursive: true }).catch(console.error);
});

// Conectar ao PM2
pm2.connect((err) => {
  if (err) {
    console.error('❌ Falha ao conectar ao PM2:', err);
    process.exit(1);
  }
  console.log('✅ Conectado ao daemon do PM2');
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'pm2-caddy-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.set('view engine', 'ejs');

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Função para extrair portas do docker-compose.yml
async function extractPortsFromCompose(projectName) {
  try {
    const composePath = path.join(DOCKER_PROJECTS_DIR, projectName, 'docker-compose.yml');
    if (!await fs.access(composePath).then(() => true).catch(() => false)) {
      return [];
    }
    const composeContent = await fs.readFile(composePath, 'utf8');
    const compose = yaml.parse(composeContent);
    const ports = [];
    if (compose.services) {
      for (const serviceName in compose.services) {
        const service = compose.services[serviceName];
        if (service.ports) {
          service.ports.forEach(portMapping => {
            if (typeof portMapping === 'string') {
              const parts = portMapping.split(':');
              if (parts.length >= 2) {
                const hostPort = parts[0];
                if (hostPort && !ports.includes(hostPort)) {
                  ports.push(hostPort);
                }
              }
            } else if (typeof portMapping === 'object' && portMapping.published) {
              if (!ports.includes(portMapping.published.toString())) {
                ports.push(portMapping.published.toString());
              }
            }
          });
        }
      }
    }
    return ports;
  } catch (error) {
    console.error('Erro ao extrair portas de', projectName, ':', error.message);
    return [];
  }
}

// Função auxiliar: verificar se é um repositório Git
async function isGitRepo(dirPath) {
  try {
    const gitDir = path.join(dirPath, '.git');
    const stats = await fs.stat(gitDir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

// ========== ROTAS DE LOGIN ========== //
app.get('/login', (req, res) => res.render('login', { error: null }));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.USER_NAME && await bcrypt.compare(password, process.env.PASSWORD_HASH)) {
    req.session.user = username;
    return res.redirect('/');
  }
  res.render('login', { error: 'Usuário ou senha inválidos' });
});
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ========== ROTAS PM2 ========== //
app.get('/dashboard', requireLogin, (req, res) => {
  pm2.list((err, processes) => {
    if (err) return res.status(500).send('Erro ao listar processos');
    res.render('dashboard', { processes });
  });
});

app.post('/api/pm2/start', requireLogin, (req, res) => {
  const { name, script, args = '' } = req.body;
  pm2.start({ name, script, args: args.split(' ').filter(x => x) }, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

['stop', 'restart', 'delete', 'start'].forEach(action => {
  app.post(`/api/pm2/${action}/:name`, requireLogin, (req, res) => {
    pm2[action](req.params.name, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
  });
});

app.get('/api/pm2/logs/:name?', requireLogin, async (req, res) => {
  const name = req.params.name || 'all';
  const LOGS_DIR = path.join(require('os').homedir(), '.pm2', 'logs');
  try {
    if (name === 'all') {
      const files = await fs.readdir(LOGS_DIR);
      const logFiles = files.filter(f => f.endsWith('.log'));
      let allLogs = '';
      for (const file of logFiles) {
        const content = await fs.readFile(path.join(LOGS_DIR, file), 'utf8');
        allLogs += `\n\n=== ${file} ===\n${content}`;
      }
      const lines = allLogs.split('\n').slice(-200).join('\n');
      return res.json({ logs: lines });
    } else {
      const outLog = path.join(LOGS_DIR, `${name}-out.log`);
      const errorLog = path.join(LOGS_DIR, `${name}-error.log`);
      let logs = '';
      if (await fs.access(outLog).then(() => true).catch(() => false)) {
        logs += await fs.readFile(outLog, 'utf8');
      }
      if (await fs.access(errorLog).then(() => true).catch(() => false)) {
        logs += '\n' + await fs.readFile(errorLog, 'utf8');
      }
      const lines = logs.split('\n').slice(-200).join('\n');
      res.json({ logs: lines || 'Sem logs disponíveis' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message, logs: '' });
  }
});

// ========== ROTAS FILE MANAGER ========== //
app.get('/filemanager', requireLogin, (req, res) => {
  res.render('filemanager');
});

// ========== ROTAS CADDY ========== //
app.get('/caddy', requireLogin, async (req, res) => {
  try {
    const files = await fs.readdir(SITES_ENABLED_DIR);
    const sites = files
      .filter(f => f.endsWith('.caddy'))
      .map(f => ({ name: f.replace(/\.caddy$/, ''), file: f }));
    res.render('caddy', { sites });
  } catch (err) {
    res.render('caddy', { sites: [], error: err.message });
  }
});

app.get('/caddy/new', requireLogin, (req, res) => {
  res.render('caddy-edit', { domain: '', config: '', isNew: true });
});

app.get('/caddy/edit/:domain', requireLogin, async (req, res) => {
  const file = `${req.params.domain}.caddy`;
  const filePath = path.join(SITES_ENABLED_DIR, file);
  try {
    const config = await fs.readFile(filePath, 'utf8');
    res.render('caddy-edit', { domain: req.params.domain, config, isNew: false });
  } catch (err) {
    res.status(404).send('Domínio não encontrado');
  }
});

app.post('/api/caddy/save', requireLogin, async (req, res) => {
  const { domain, config } = req.body;
  if (!domain || !config) {
    return res.status(400).json({ error: 'Domínio e configuração são obrigatórios' });
  }
  const safeDomain = domain.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '');
  const fileName = `${safeDomain}.caddy`;
  const filePath = path.join(SITES_ENABLED_DIR, fileName);
  try {
    await fs.writeFile(filePath, config.trim() + '\n', 'utf8');
    res.json({ success: true, message: `✅ Domínio ${safeDomain} salvo com sucesso!` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/caddy/delete/:domain', requireLogin, async (req, res) => {
  const file = `${req.params.domain}.caddy`;
  const filePath = path.join(SITES_ENABLED_DIR, file);
  try {
    await fs.unlink(filePath);
    res.json({ success: true, message: `✅ Domínio ${req.params.domain} removido.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== ROTAS DOCKER COMPOSE ========== //
app.get('/docker', requireLogin, async (req, res) => {
  try {
    const dirs = await fs.readdir(DOCKER_PROJECTS_DIR);
    const projects = [];
    for (const dir of dirs) {
      const dirPath = path.join(DOCKER_PROJECTS_DIR, dir);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;
      const composePath = path.join(dirPath, 'docker-compose.yml');
      const exists = await fs.access(composePath).then(() => true).catch(() => false);
      if (exists) {
        let status = 'stopped';
        try {
          const { stdout } = await new Promise((resolve, reject) => {
            require('child_process').exec(`cd "${dirPath}" && docker compose ps`, (error, stdout, stderr) => {
              if (error && error.code !== 1) return reject(error);
              resolve({ stdout });
            });
          });
          if (stdout.includes('Up') || stdout.toLowerCase().includes('running')) status = 'running';
          else if (stdout.includes('Exit') || stdout.toLowerCase().includes('stopped')) status = 'stopped';
          else status = 'not started';
        } catch (err) {
          console.warn(`Não foi possível verificar status de ${dir}:`, err.message);
          status = 'error';
        }
        const ports = await extractPortsFromCompose(dir);
        projects.push({ name: dir, status, ports, path: dirPath });
      }
    }
    res.render('docker', { projects, user: req.session.user, error: req.query.error });
  } catch (err) {
    console.error('Erro ao listar projetos Docker:', err);
    res.render('docker', { projects: [], error: err.message });
  }
});

// ========== API DOCKER ========== //
app.get('/api/docker/compose/:project', requireLogin, async (req, res) => {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, req.params.project);
  const composePath = path.join(projectDir, 'docker-compose.yml');
  try {
    const content = await fs.readFile(composePath, 'utf8');
    res.json({ success: true, content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/docker/compose/:project', requireLogin, async (req, res) => {
  const { content } = req.body;
  const projectDir = path.join(DOCKER_PROJECTS_DIR, req.params.project);
  const composePath = path.join(projectDir, 'docker-compose.yml');
  try {
    await fs.writeFile(composePath, content.trim() + '\n', 'utf8');
    res.json({ success: true, message: 'Arquivo salvo!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ ROTA DE EXCLUSÃO — usa docker compose down --rmi all -v
app.post('/api/docker/delete/:project', requireLogin, async (req, res) => {
  const projectName = req.params.project;
  const projectDir = path.join(DOCKER_PROJECTS_DIR, projectName);

  try {
    await fs.access(projectDir);

    // Executa o comando exato dentro da pasta do projeto
    await new Promise((resolve, reject) => {
      require('child_process').exec(
        `cd "${projectDir}" && docker compose down --rmi all -v`,
        { timeout: 120000 }, // 2 minutos
        (error, stdout, stderr) => {
          if (error) {
            console.warn(`[Aviso] docker compose down falhou para ${projectName}:`, stderr || error.message);
          }
          resolve();
        }
      );
    });

    // Remove a pasta do projeto
    await fs.rm(projectDir, { recursive: true, force: true });

    res.json({
      success: true,
      message: `Projeto "${projectName}" excluído completamente!`
    });

  } catch (err) {
    console.error(`Erro ao excluir projeto ${projectName}:`, err);
    res.status(500).json({
      success: false,
      error: err.message || 'Erro desconhecido ao excluir projeto'
    });
  }
});

// Outras rotas Docker (up, down, restart, logs, upload, services)
app.get('/api/docker/up-stream/:project', requireLogin, async (req, res) => {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, req.params.project);
  try {
    await fs.access(projectDir);
  } catch {
    return res.status(404).json({ success: false, error: 'Projeto não encontrado' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const proc = require('child_process').spawn('sh', ['-c', `cd "${projectDir}" && docker compose up --build`], {
    cwd: projectDir,
    env: process.env
  });

  proc.stdout.on('data', (data) => {
    const clean = data.toString().replace(/\x1b\[[0-9;]*m/g, '');
    res.write(`data: {"status": "output", "message": ${JSON.stringify(clean)}}\n\n`);
  });

  proc.stderr.on('data', (data) => {
    const clean = data.toString().replace(/\x1b\[[0-9;]*m/g, '');
    res.write(`data: {"status": "error", "message": ${JSON.stringify(clean)}}\n\n`);
  });

  proc.on('close', (code) => {
    if (code === 0) {
      res.write('data: {"status": "success", "message": "Projeto iniciado com sucesso!"}\n\n');
    } else {
      res.write(`data: {"status": "failed", "message": "Erro ao iniciar (código: ${code})"}\n\n`);
    }
    res.end();
  });

  req.on('close', () => {
    if (proc && !proc.killed) proc.kill('SIGTERM');
  });
});

app.post('/api/docker/down/:project', requireLogin, async (req, res) => {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, req.params.project);
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      require('child_process').exec(
        `cd "${projectDir}" && docker compose down`,
        { timeout: 60000 },
        (error, stdout, stderr) => {
          if (error) reject({ error, stdout, stderr });
          resolve({ stdout, stderr });
        }
      );
    });
    res.json({ success: true, message: 'Projeto parado com sucesso!', output: stdout + stderr });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/docker/restart/:project', requireLogin, async (req, res) => {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, req.params.project);
  try {
    await new Promise((resolve, reject) => {
      require('child_process').exec(
        `cd "${projectDir}" && docker compose restart`,
        { timeout: 60000 },
        (error, stdout, stderr) => {
          if (error) reject({ error, stdout, stderr });
          resolve({ stdout, stderr });
        }
      );
    });
    res.json({ success: true, message: 'Projeto reiniciado com sucesso!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/docker/logs/:project', requireLogin, async (req, res) => {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, req.params.project);
  try {
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      require('child_process').exec(
        `cd "${projectDir}" && docker compose logs --tail=100`,
        { timeout: 10000 },
        (error, stdout, stderr) => {
          if (error) reject({ error, stdout, stderr });
          resolve({ stdout, stderr });
        }
      );
    });
    res.json({ success: true, logs: stdout || stderr || 'Sem logs.' });
  } catch (err) {
    res.status(500).json({ success: false, logs: 'Erro ao carregar logs: ' + err.message });
  }
});

app.post('/api/docker/upload', requireLogin, async (req, res) => {
  const { projectName, composeContent } = req.body;
  if (!projectName || !composeContent) {
    return res.status(400).json({ success: false, error: 'Nome e conteúdo são obrigatórios.' });
  }
  const safeName = projectName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const projectDir = path.join(DOCKER_PROJECTS_DIR, safeName);
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'docker-compose.yml'), composeContent.trim() + '\n', 'utf8');
    res.json({ success: true, message: `Projeto "${safeName}" criado com sucesso!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/docker/services/:project', requireLogin, async (req, res) => {
  const projectDir = path.join(DOCKER_PROJECTS_DIR, req.params.project);
  try {
    await fs.access(projectDir);
    const { stdout } = await new Promise((resolve, reject) => {
      require('child_process').exec(
        `cd "${projectDir}" && docker compose config --services`,
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr || 'Erro ao carregar serviços'));
          else resolve({ stdout });
        }
      );
    });
    const services = stdout.trim().split('\n').filter(s => s.trim() !== '');
    const servicesWithStatus = [];
    for (const service of services) {
      try {
        const { stdout: psOut } = await new Promise((resolve, reject) => {
          require('child_process').exec(
            `cd "${projectDir}" && docker compose ps ${service}`,
            (error, stdout, stderr) => {
              if (error) reject(new Error(stderr || 'Erro ao verificar status'));
              else resolve({ stdout: stdout });
            }
          );
        });
        let status = 'not running';
        if (psOut.includes('Up')) status = 'running';
        else if (psOut.includes('Exit')) status = 'exited';
        servicesWithStatus.push({ name: service, status });
      } catch (err) {
        servicesWithStatus.push({ name: service, status: 'unknown' });
      }
    }
    res.json({ success: true, services: servicesWithStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== ROTAS GIT ========== //
app.get('/git', requireLogin, (req, res) => {
  res.render('git', { user: req.session.user });
});

app.get('/api/git/repos', requireLogin, async (req, res) => {
  const repos = [];
  const scanDir = async (baseDir, type) => {
    try {
      const items = await fs.readdir(baseDir);
      for (const item of items) {
        const fullPath = path.join(baseDir, item);
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory() && await isGitRepo(fullPath)) {
          repos.push({ name: item, type, path: fullPath });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Erro ao escanear ${baseDir}:`, err.message);
    }
  };
  await scanDir(GIT_APP_DIR, 'app');
  await scanDir(GIT_WWW_DIR, 'www');
  await scanDir(GIT_DOCKER_DIR, 'docker');
  res.json({ success: true, repos });
});

app.post('/api/git/clone', requireLogin, async (req, res) => {
  const { repoUrl, projectType, projectName } = req.body;
  if (!repoUrl || !projectType) {
    return res.status(400).json({ success: false, error: 'URL e tipo são obrigatórios.' });
  }
  let targetDir;
  switch (projectType) {
    case 'app': targetDir = GIT_APP_DIR; break;
    case 'www': targetDir = GIT_WWW_DIR; break;
    case 'docker': targetDir = GIT_DOCKER_DIR; break;
    default: return res.status(400).json({ success: false, error: 'Tipo inválido.' });
  }
  try {
    await fs.mkdir(targetDir, { recursive: true });
    let folderName = projectName || repoUrl.split('/').pop().replace(/\.git$/, '');
    folderName = folderName.replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 100);
    const projectPath = path.join(targetDir, folderName);
    if (await fs.access(projectPath).then(() => true).catch(() => false)) {
      return res.status(409).json({ success: false, error: `Projeto já existe em: ${projectPath}` });
    }
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      require('child_process').exec(
        `cd "${targetDir}" && git clone "${repoUrl}" "${folderName}"`,
        { timeout: 120000 },
        (error, stdout, stderr) => {
          if (error) reject({ error, stdout, stderr });
          else resolve({ stdout, stderr });
        }
      );
    });
    res.json({ success: true, message: `✅ Repositório clonado em ${projectPath}`, path: projectPath });
  } catch (err) {
    const errorMsg = err.stderr || err.stdout || err.message || 'Erro ao clonar';
    res.status(500).json({ success: false, error: errorMsg });
  }
});

app.post('/api/git/pull', requireLogin, async (req, res) => {
  const { projectPath } = req.body;
  if (!projectPath) {
    return res.status(400).json({ success: false, error: 'Caminho é obrigatório.' });
  }
  const allowedRoots = [GIT_APP_DIR, GIT_WWW_DIR, GIT_DOCKER_DIR];
  const resolvedPath = path.resolve(projectPath);
  const isAllowed = allowedRoots.some(root => resolvedPath.startsWith(path.resolve(root)));
  if (!isAllowed) {
    return res.status(403).json({ success: false, error: 'Acesso negado.' });
  }
  try {
    await fs.access(path.join(projectPath, '.git'));
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      require('child_process').exec(
        `cd "${projectPath}" && git pull`,
        { timeout: 60000 },
        (error, stdout, stderr) => {
          if (error) reject({ error, stdout, stderr });
          else resolve({ stdout, stderr });
        }
      );
    });
    res.json({ success: true, message: '✅ Pull realizado!', output: stdout + stderr });
  } catch (err) {
    const errorMsg = err.stderr || err.stdout || err.message || 'Erro ao executar git pull';
    res.status(500).json({ success: false, error: errorMsg });
  }
});

// ========== PÁGINA INICIAL ========== //
app.get('/', requireLogin, (req, res) => {
  const domainsPromise = fs.readdir(SITES_ENABLED_DIR)
    .then(files => files.filter(f => f.endsWith('.caddy')).map(f => ({ name: f.replace(/\.caddy$/, ''), file: f })))
    .catch(() => []);
  const processesPromise = new Promise((resolve) => {
    pm2.list((err, processes) => {
      if (err) resolve([]);
      else resolve((processes || []).map(p => ({
        name: p.name || p.pm2_env?.name || 'unknown',
        cpu: typeof p.cpu === 'number' ? p.cpu : 0,
        memory: typeof p.memory === 'number' ? p.memory : 0,
        status: p.pm2_env?.status || 'unknown'
      })));
    });
  });
  Promise.all([domainsPromise, processesPromise])
    .then(([sites, processes]) => {
      res.render('home', { sites, processes, user: req.session.user });
    })
    .catch(err => {
      console.error('Erro crítico ao carregar home:', err);
      res.status(500).send('Erro ao carregar dashboard');
    });
});

app.get('/home', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.redirect('/');
});

app.get('/api/domains', requireLogin, async (req, res) => {
  try {
    const files = await fs.readdir(SITES_ENABLED_DIR);
    const sites = files.filter(f => f.endsWith('.caddy')).map(f => ({ name: f.replace(/\.caddy$/, ''), file: f }));
    res.json({ sites });
  } catch (err) {
    res.status(500).json({ error: err.message, sites: [] });
  }
});

app.get('/api/processes', requireLogin, (req, res) => {
  pm2.list((err, processes) => {
    if (err) return res.status(500).json({ error: err.message, processes: [] });
    const safeProcesses = (processes || []).map(p => ({
      name: p.name || p.pm2_env?.name || 'unknown',
      cpu: typeof p.cpu === 'number' ? p.cpu : 0,
      memory: typeof p.memory === 'number' ? p.memory : 0,
      status: p.pm2_env?.status || 'unknown'
    }));
    res.json({ processes: safeProcesses });
  });
});

app.post('/api/caddy/reload', requireLogin, async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      require('child_process').exec('caddy reload --config /etc/caddy/Caddyfile', (error, stdout, stderr) => {
        if (error) reject({ error, stdout, stderr });
        else resolve({ stdout, stderr });
      });
    });
    res.json({ success: true, message: 'Caddy recarregado com sucesso' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================ Auto instalador ========== //
const WWW_PROJECTS_DIR = GIT_WWW_DIR; // WordPress ficará em Projects/www/

// ========== AUTO: LISTAR SITES WORDPRESS ========== //
app.get('/auto', requireLogin, (req, res) => {
  res.render('auto');
});

// API: listar sites em www (pastas que contêm wp-config.php ou wp-includes)
// ========== AUTO: LISTAR SITES WORDPRESS ========== //
app.get('/api/auto/sites', requireLogin, async (req, res) => {
  try {
    // Paginação via query params: ?page=1&limit=10
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);

    const items = await fs.readdir(WWW_PROJECTS_DIR);
    const sites = [];

    for (const item of items) {
      const fullPath = path.join(WWW_PROJECTS_DIR, item);
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) continue;

      // Verifica se é um site WordPress pelo arquivo wp-config-sample.php + pasta wp-includes
      const hasConfigSample = await fs.access(path.join(fullPath, 'wp-config-sample.php')).then(() => true).catch(() => false);
      const hasIncludes = await fs.access(path.join(fullPath, 'wp-includes')).then(() => true).catch(() => false);

      if (hasConfigSample && hasIncludes) {
        sites.push({ name: item });
      }
    }

    // Filtro de pesquisa (query param 'q') - busca por substring no nome
    const q = (req.query.q || '').toString().trim().toLowerCase();
    const filteredSites = q ? sites.filter(s => s.name.toLowerCase().includes(q)) : sites;

    const total = filteredSites.length;
    const start = (page - 1) * limit;
    const end = start + limit;
    const paginated = filteredSites.slice(start, end);

    res.json({ success: true, sites: paginated, total });
  } catch (err) {
    console.error('Erro ao listar sites:', err);
    res.status(500).json({ success: false, sites: [], total: 0, error: err.message });
  }
});

// ========== AUTO: INSTALAR WORDPRESS PT-BR ========== //
app.post('/api/auto/install', requireLogin, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ success: false, error: 'Nome é obrigatório.' });
  }

  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const projectDir = path.join(WWW_PROJECTS_DIR, safeName);

  try {
    if (await fs.access(projectDir).then(() => true).catch(() => false)) {
      return res.status(409).json({ success: false, error: `A pasta "${safeName}" já existe.` });
    }

    await fs.mkdir(projectDir, { recursive: true });
    const tarballPath = path.join(projectDir, 'wordpress.tar.gz');
    const wpUrl = 'https://br.wordpress.org/wordpress-6.7.1-pt_BR.tar.gz';

    // Baixar
    const response = await fetch(wpUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    await fs.writeFile(tarballPath, Buffer.from(buffer));

    // Descompactar
    await new Promise((resolve, reject) => {
      const cp = require('child_process').spawn('tar', ['-xzf', 'wordpress.tar.gz', '-C', '.'], { cwd: projectDir });
      cp.on('close', code => code === 0 ? resolve() : reject(new Error(`tar code ${code}`)));
      cp.on('error', reject);
    });

    // Mover conteúdo de /wordpress para raiz
    const wpDir = path.join(projectDir, 'wordpress');
    const files = await fs.readdir(wpDir);
    for (const file of files) {
      await fs.rename(path.join(wpDir, file), path.join(projectDir, file));
    }
    await fs.rm(wpDir, { recursive: true });
    await fs.unlink(tarballPath);

    res.json({ success: true, name: safeName });
  } catch (err) {
    console.error('Falha na instalação:', err);
    try { await fs.rm(projectDir, { recursive: true, force: true }); } catch { }
    res.status(500).json({ success: false, error: err.message || 'Erro ao instalar.' });
  }
});

// ========== AUTO: EDITAR wp-config.php ========== //
app.get('/api/auto/config/:site', requireLogin, async (req, res) => {
  const site = req.params.site;
  const configPath = path.join(WWW_PROJECTS_DIR, site, 'wp-config.php');
  try {
    const content = await fs.readFile(configPath, 'utf8');
    res.json({ success: true, content });
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Cria um wp-config.php básico se não existir
      const samplePath = path.join(WWW_PROJECTS_DIR, site, 'wp-config-sample.php');
      if (await fs.access(samplePath).then(() => true).catch(() => false)) {
        const sample = await fs.readFile(samplePath, 'utf8');
        res.json({ success: true, content: sample });
      } else {
        res.status(404).json({ success: false, error: 'wp-config.php não encontrado.' });
      }
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

app.post('/api/auto/config/:site', requireLogin, async (req, res) => {
  const { content } = req.body;
  const site = req.params.site;
  const configPath = path.join(WWW_PROJECTS_DIR, site, 'wp-config.php');
  try {
    await fs.writeFile(configPath, content, 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== AUTO: EXCLUIR SITE ========== //
app.post('/api/auto/delete/:site', requireLogin, async (req, res) => {
  const site = req.params.site;
  const projectDir = path.join(WWW_PROJECTS_DIR, site);
  try {
    await fs.rm(projectDir, { recursive: true, force: true });
    res.json({ success: true, message: `Site "${site}" excluído.` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

//============= COMPOSER =============//


// ========== COMPOSER / LARAVEL ========== //
const LARAVEL_PROJECTS_DIRS = [GIT_APP_DIR, GIT_WWW_DIR]; // Procura em app/ e www/

// Detecta projetos Laravel
async function findLaravelProjects() {
  const projects = [];
  for (const baseDir of LARAVEL_PROJECTS_DIRS) {
    try {
      const items = await fs.readdir(baseDir);
      for (const item of items) {
        const fullPath = path.join(baseDir, item);
        const stat = await fs.stat(fullPath);
        if (!stat.isDirectory()) continue;

        const hasArtisan = await fs.access(path.join(fullPath, 'artisan')).then(() => true).catch(() => false);
        const hasComposer = await fs.access(path.join(fullPath, 'composer.json')).then(() => true).catch(() => false);

        if (hasArtisan && hasComposer) {
          projects.push({ name: item, path: fullPath, base: baseDir === GIT_APP_DIR ? 'app' : 'www' });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Erro ao escanear ${baseDir}:`, err.message);
    }
  }
  return projects;
}

// Rota principal
app.get('/composer', requireLogin, (req, res) => {
  res.render('composer');
});

// API: listar projetos Laravel
app.get('/api/composer/projects', requireLogin, async (req, res) => {
  try {
    const projects = await findLaravelProjects();
    res.json({ success: true, projects });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: executar comando (streaming)
// API: executar comando (streaming)
app.get('/api/composer/run/:project/:action', requireLogin, async (req, res) => {
  const { project, action } = req.params;

  // Definir comandos
  const actions = {
    'composer-install': 'composer install --no-interaction --prefer-dist --optimize-autoloader',
    'composer-update': 'composer update --no-interaction --prefer-dist --optimize-autoloader',
    'key-generate': 'php artisan key:generate',
    'clear-all': 'php artisan config:clear && php artisan cache:clear && php artisan view:clear && php artisan route:clear',
    'migrate': 'php artisan migrate --force',
    'migrate-fresh': 'php artisan migrate:fresh --seed --force'
  };

  if (!actions[action]) {
    return res.status(400).json({ error: 'Ação inválida' });
  }

  // Encontrar projeto
  let proj = null;
  try {
    const projects = await findLaravelProjects();
    proj = projects.find(p => p.name === project);
  } catch (err) {
    console.error('Erro ao buscar projetos:', err);
    return res.status(500).json({ error: 'Erro ao buscar projetos' });
  }

  if (!proj) {
    return res.status(404).json({ error: 'Projeto não encontrado' });
  }

  // Configurar resposta SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Iniciar processo
  const cmd = actions[action];
  const proc = require('child_process').spawn('sh', ['-c', cmd], {
    cwd: proj.path,
    env: {
      ...process.env,
      COMPOSER_HOME: '/tmp',
      PATH: process.env.PATH + ':/usr/local/bin:/usr/bin' // Garante que composer/php estejam no PATH
    }
  });

  // Enviar dados
  const send = (type, data) => {
    res.write(`data: {"${type}": ${JSON.stringify(data)}}\n\n`);
  };

  proc.stdout.on('data', (data) => send('output', data.toString()));
  proc.stderr.on('data', (data) => send('error', data.toString()));

  proc.on('close', (code) => {
    send('exit', code);
    res.end();
  });

  proc.on('error', (err) => {
    send('error', `Falha ao iniciar processo: ${err.message}`);
    res.end();
  });

  // Fechar ao desconectar
  req.on('close', () => {
    if (proc.pid) {
      proc.kill('SIGTERM');
    }
  });
});

// API: ler .env
app.get('/api/composer/env/:project', requireLogin, async (req, res) => {
  const { project } = req.params;
  const projects = await findLaravelProjects();
  const proj = projects.find(p => p.name === project);
  if (!proj) return res.status(404).json({ error: 'Projeto não encontrado' });

  const envPath = path.join(proj.path, '.env');
  try {
    const content = await fs.readFile(envPath, 'utf8');
    res.json({ success: true, content });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.json({ success: true, content: '' });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// API: salvar .env
app.post('/api/composer/env/:project', requireLogin, async (req, res) => {
  const { project } = req.params;
  const { content } = req.body;
  const projects = await findLaravelProjects();
  const proj = projects.find(p => p.name === project);
  if (!proj) return res.status(404).json({ error: 'Projeto não encontrado' });

  const envPath = path.join(proj.path, '.env');
  try {
    await fs.writeFile(envPath, content.trim() + '\n', 'utf8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== SERVIDOR ========== //
const http = require('http');
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`✅ Painel rodando em http://localhost:${PORT}`);
  console.log(`🔐 Login: ${process.env.USER_NAME} / senha123`);
  console.log(`📁 Domínios: ${SITES_ENABLED_DIR}`);
  console.log(`🐳 Projetos Docker: ${DOCKER_PROJECTS_DIR}`);
  console.log(`📦 Projetos Git: app=${GIT_APP_DIR}, www=${GIT_WWW_DIR}`);
});