import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const safeFilename = typeof __filename !== 'undefined'
  ? __filename
  : fileURLToPath(import.meta.url);

const safeDirname = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(safeFilename);

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// Backend roda atrás do Traefik (proxy reverso) -> necessário para IP/proto corretos
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS não é necessário: frontend e backend ficam sob o mesmo domínio
// (educacional.serrinhaconectada.tech e educacional.serrinhaconectada.tech/api),
// o roteamento é feito por path no Traefik. Caso no futuro o frontend passe a
// rodar em outro domínio/subdomínio, reative um middleware de CORS aqui.

// PostgreSQL Connection
const connectionString = process.env.DATABASE_URL || 'postgresql://postgres.jlegxtwwllpbjudsbgtp:59aa56193be5bdab4e78060d6feeaf81@aws-0-ca-central-1.pooler.supabase.com:6543/postgres';

// SSL é controlado explicitamente por DB_SSL (default: desligado).
// Bancos internos na mesma rede Docker (ex.: nosso Postgres na VPS) normalmente
// não têm SSL configurado. Para bancos externos gerenciados (ex.: Supabase),
// defina DB_SSL=true no ambiente do serviço.
const dbSsl = process.env.DB_SSL === 'true';

const pool = new pg.Pool({
  connectionString,
  ssl: dbSsl ? { rejectUnauthorized: false } : false
});

// Row Mappers
function mapSchoolRow(s: any) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    modalities: Array.isArray(s.modalities) ? s.modalities : [],
    directorUsername: s.director_username,
    directorPasswordHash: s.director_password_hash,
    recpswrec: s.recpswrec || '',
    contactPhone: s.contact_phone || '',
    contactEmail: s.contact_email || '',
    address: s.address || '',
    directorName: s.director_name || 'Diretor(a)',
    createdAt: s.created_at
  };
}

function mapApplicationRow(r: any) {
  if (!r) return null;
  return {
    protocol: r.protocol,
    modality: r.modality,
    schoolId: r.school_id,
    schoolName: r.school_name,
    studentName: r.student_name,
    lastGradeCompleted: r.last_grade_completed,
    enteringGrade: r.entering_grade,
    birthDate: r.birth_date ? new Date(r.birth_date).toISOString().split('T')[0] : null,
    age: r.age,
    gender: r.gender,
    raceColor: r.race_color,
    motherName: r.mother_name,
    fatherName: r.father_name,
    motherCpf: r.mother_cpf,
    fatherCpf: r.father_cpf,
    useResponsibleRg: r.use_responsible_rg,
    rgDocumentUrl: r.rg_document_url,
    rgDocumentName: r.rg_document_name,
    transcriptUrl: r.transcript_url,
    transcriptName: r.transcript_name,
    phone: r.phone,
    email: r.email,
    street: r.street,
    number: r.number,
    neighborhood: r.neighborhood,
    city: r.city,
    income: r.income,
    bolsaFamilia: r.bolsa_familia,
    status: r.status,
    rejectionReason: r.rejection_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function mapAdminRow(r: any) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    email: r.email,
    passwordHash: r.password_hash,
    recpswrec: r.recpswrec || '',
    isMaster: r.is_master,
    status: r.status,
    createdAt: r.created_at
  };
}

// Database Operations (PostgreSQL)
async function dbGetSchools(modality?: string) {
  let query = 'SELECT * FROM schools ORDER BY name ASC';
  let params: any[] = [];
  if (modality) {
    query = 'SELECT * FROM schools WHERE $1 = ANY(modalities) ORDER BY name ASC';
    params = [modality];
  }
  const res = await pool.query(query, params);
  return res.rows.map(mapSchoolRow);
}

async function dbGetSchoolByUsername(username: string) {
  const res = await pool.query('SELECT * FROM schools WHERE LOWER(director_username) = LOWER($1)', [username.trim()]);
  if (res.rows.length === 0) return null;
  return mapSchoolRow(res.rows[0]);
}

async function dbGetSchoolByEmail(email: string) {
  const res = await pool.query('SELECT * FROM schools WHERE LOWER(contact_email) = LOWER($1)', [email.trim()]);
  if (res.rows.length === 0) return null;
  return mapSchoolRow(res.rows[0]);
}

async function dbGetSchoolById(id: string) {
  const res = await pool.query('SELECT * FROM schools WHERE id = $1', [id]);
  if (res.rows.length === 0) return null;
  return mapSchoolRow(res.rows[0]);
}

async function dbUpdateSchoolEmail(id: string, email: string) {
  await pool.query('UPDATE schools SET contact_email = $2 WHERE id = $1', [id, email]);
}

// Modalidades válidas (mesmas usadas pelo frontend), para validar importações em lote
const ALLOWED_MODALITIES = ['educacao-infantil', 'ensino-fundamental', 'ensino-medio', 'eja'];

async function dbCreateSchool(s: any) {
  await pool.query(
    `INSERT INTO schools (id, name, modalities, director_username, director_password_hash, recpswrec, contact_phone, contact_email, address, director_name, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())`,
    [
      s.id,
      s.name,
      s.modalities,
      s.directorUsername,
      s.directorPasswordHash,
      s.recpswrec || '',
      s.contactPhone,
      s.contactEmail,
      s.address,
      s.directorName
    ]
  );
}

async function dbDeleteSchool(id: string) {
  await pool.query('DELETE FROM schools WHERE id = $1', [id]);
}

async function dbCreateApplication(data: any) {
  const res = await pool.query(
    `INSERT INTO applications (
      protocol, modality, school_id, school_name, student_name, last_grade_completed,
      entering_grade, birth_date, age, gender, race_color, mother_name, father_name,
      mother_cpf, father_cpf, use_responsible_rg, rg_document_url, rg_document_name,
      transcript_url, transcript_name, phone, email, street, number, neighborhood,
      city, income, bolsa_familia, status, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
      $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, NOW(), NOW()
    ) RETURNING *`,
    [
      data.protocol,
      data.modality,
      data.schoolId,
      data.schoolName,
      data.studentName,
      data.lastGradeCompleted || '',
      data.enteringGrade || '',
      data.birthDate || null,
      data.age ?? null,
      data.gender || '',
      data.raceColor || '',
      data.motherName || '',
      data.fatherName || '',
      data.motherCpf || '',
      data.fatherCpf || '',
      !!data.useResponsibleRg,
      data.rgDocumentUrl || '',
      data.rgDocumentName || '',
      data.transcriptUrl || '',
      data.transcriptName || '',
      data.phone || '',
      data.email || '',
      data.street || '',
      data.number || '',
      data.neighborhood || '',
      data.city || '',
      data.income || '',
      !!data.bolsaFamilia,
      'Pendente'
    ]
  );
  return mapApplicationRow(res.rows[0]);
}

async function dbGetApplicationByProtocol(protocol: string) {
  const res = await pool.query('SELECT * FROM applications WHERE UPPER(protocol) = UPPER($1)', [protocol.trim()]);
  if (res.rows.length === 0) return null;
  return mapApplicationRow(res.rows[0]);
}

async function dbGetApplicationsBySchool(schoolId: string) {
  const res = await pool.query('SELECT * FROM applications WHERE school_id = $1 ORDER BY created_at DESC', [schoolId]);
  return res.rows.map(mapApplicationRow);
}

async function dbGetAllApplications() {
  const res = await pool.query('SELECT * FROM applications ORDER BY created_at DESC');
  return res.rows.map(mapApplicationRow);
}

async function dbUpdateApplicationStatus(protocol: string, status: string, rejectionReason?: string) {
  const res = await pool.query(
    'UPDATE applications SET status = $2, rejection_reason = $3, updated_at = NOW() WHERE protocol = $1 RETURNING *',
    [protocol, status, rejectionReason || null]
  );
  if (res.rows.length === 0) return null;
  return mapApplicationRow(res.rows[0]);
}

async function dbGetAdminByUsername(username: string) {
  const res = await pool.query('SELECT * FROM admins WHERE LOWER(username) = LOWER($1)', [username.trim()]);
  if (res.rows.length === 0) return null;
  return mapAdminRow(res.rows[0]);
}

async function dbGetAdminByEmail(email: string) {
  const res = await pool.query('SELECT * FROM admins WHERE LOWER(email) = LOWER($1)', [email.trim()]);
  if (res.rows.length === 0) return null;
  return mapAdminRow(res.rows[0]);
}

async function dbGetAllAdmins() {
  const res = await pool.query('SELECT * FROM admins ORDER BY created_at DESC');
  return res.rows.map(mapAdminRow);
}

async function dbGetPendingAdmins() {
  const res = await pool.query("SELECT * FROM admins WHERE status = 'pending' ORDER BY created_at DESC");
  return res.rows.map(mapAdminRow);
}

async function dbCreateAdmin(admin: any) {
  const res = await pool.query(
    `INSERT INTO admins (id, username, email, password_hash, recpswrec, is_master, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING *`,
    [admin.id, admin.username, admin.email, admin.passwordHash, admin.recpswrec || '', admin.isMaster, admin.status]
  );
  return mapAdminRow(res.rows[0]);
}

async function dbUpdateAdminStatus(id: string, status: string) {
  await pool.query('UPDATE admins SET status = $2 WHERE id = $1', [id, status]);
}

async function dbDeleteAdmin(id: string) {
  await pool.query('DELETE FROM admins WHERE id = $1', [id]);
}

async function dbUpdateAdminPassword(id: string, passwordHash: string, rawPassword?: string) {
  if (rawPassword) {
    await pool.query('UPDATE admins SET password_hash = $2, recpswrec = $3 WHERE id = $1', [id, passwordHash, rawPassword]);
  } else {
    await pool.query('UPDATE admins SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
  }
}

let memoryAnnouncement = {
  title: 'Aviso Importante sobre Pré-Matrículas',
  content: 'As inscrições normalmente se iniciam nas datas próximas ao fim do ano letivo, fique atento às nossas redes sociais para mais informações!',
  updatedAt: new Date().toISOString()
};

async function dbGetAnnouncement() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    const res = await pool.query("SELECT value, updated_at FROM system_settings WHERE key = 'announcement'");
    if (res.rows.length > 0 && res.rows[0].value) {
      return {
        title: res.rows[0].value.title || memoryAnnouncement.title,
        content: res.rows[0].value.content || memoryAnnouncement.content,
        updatedAt: res.rows[0].updated_at ? new Date(res.rows[0].updated_at).toISOString() : memoryAnnouncement.updatedAt
      };
    }
  } catch (err) {
    console.warn('[DB Settings Warning]', err);
  }
  return memoryAnnouncement;
}

async function dbSaveAnnouncement(title: string, content: string) {
  memoryAnnouncement = {
    title,
    content,
    updatedAt: new Date().toISOString()
  };
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('announcement', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    `, [JSON.stringify({ title, content })]);
  } catch (err) {
    console.warn('[DB Save Announcement Warning]', err);
  }
  return memoryAnnouncement;
}

// Mensagem exibida ao público quando o admin encerra o período de matrículas
const ENROLLMENT_LOCKED_MESSAGE =
  'Período de Matrículas encerrado (para mais informações entre em contato com a escola ou a Secretaria de Educação. Obrigado!)';

let memoryEnrollmentLocked = false;

async function dbGetEnrollmentLocked(): Promise<boolean> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    const res = await pool.query("SELECT value FROM system_settings WHERE key = 'enrollment_lock'");
    if (res.rows.length > 0 && res.rows[0].value) {
      memoryEnrollmentLocked = !!res.rows[0].value.locked;
    }
  } catch (err) {
    console.warn('[DB Settings Warning]', err);
  }
  return memoryEnrollmentLocked;
}

async function dbSetEnrollmentLocked(locked: boolean): Promise<boolean> {
  memoryEnrollmentLocked = locked;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key VARCHAR(100) PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await pool.query(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES ('enrollment_lock', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    `, [JSON.stringify({ locked })]);
  } catch (err) {
    console.warn('[DB Save Enrollment Lock Warning]', err);
  }
  return memoryEnrollmentLocked;
}

async function dbRunHousekeeping() {
  try {
    await pool.query("DELETE FROM admins WHERE status = 'pending' AND is_master = false AND created_at < NOW() - INTERVAL '3 days'");
  } catch (e) {
    console.error('Housekeeping error:', e);
  }
}

// Ensure uploads folder exists
const uploadsDir = path.join(safeDirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Multer storage setup for document uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});
const upload = multer({ storage });

async function sendNotificationEmail(to: string, subject: string, text: string, html: string) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'nao-responda@serrinha.ba.gov.br';
  const senderName = process.env.BREVO_SENDER_NAME || 'Secretaria de Educação de Serrinha';

  if (!apiKey) {
    console.error(`[Email NÃO enviado] BREVO_API_KEY não está configurada no ambiente do backend. To: ${to} | Subject: ${subject}`);
    return;
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text
      })
    });

    if (response.ok) {
      console.log(`[Email Sent via Brevo API] To: ${to} | Subject: ${subject}`);
      return;
    }

    // Não deixa o erro passar em silêncio: loga o motivo real retornado pela Brevo
    // (ex.: remetente não verificado, chave inválida, limite excedido, etc.)
    const errorBody = await response.text().catch(() => '');
    console.error(`[Brevo API Error] Status: ${response.status} | To: ${to} | Subject: ${subject} | Response: ${errorBody}`);
  } catch (apiErr: any) {
    console.error(`[Brevo API - Falha de conexão] To: ${to} | Subject: ${subject} | Erro: ${apiErr?.message || apiErr}`);
  }

  // Fallback opcional via SMTP da Brevo, caso configurado (BREVO_SMTP_USER / BREVO_SMTP_KEY)
  const smtpUser = process.env.BREVO_SMTP_USER;
  const smtpKey = process.env.BREVO_SMTP_KEY || process.env.BREVO_SMTP_PASS;

  if (smtpUser && smtpKey) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp-relay.brevo.com',
        port: 587,
        secure: false,
        auth: {
          user: smtpUser,
          pass: smtpKey
        }
      });

      await transporter.sendMail({
        from: `"${senderName}" <${senderEmail}>`,
        to,
        subject,
        text,
        html
      });
      console.log(`[Email Sent via Brevo SMTP] To: ${to} | Subject: ${subject}`);
      return;
    } catch (smtpErr: any) {
      console.error(`[Brevo SMTP Error] To: ${to} | Subject: ${subject} | Erro: ${smtpErr?.message || smtpErr}`);
    }
  }

  console.error(`[Email NÃO enviado - todas as tentativas falharam] To: ${to} | Subject: ${subject}`);
}

// S3 / MinIO Storage Helper
function getS3Client() {
  const accessKeyId = process.env.S3_ACCESS_KEY || process.env.MINIO_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY || process.env.MINIO_SECRET_KEY;
  const endpoint = process.env.S3_ENDPOINT || (process.env.MINIO_ENDPOINT ? `http://${process.env.MINIO_ENDPOINT}` : undefined);
  const region = process.env.S3_REGION || 'us-east-1';

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

// --- API ROUTES ---

// Health check (usado por Traefik/Portainer/monitoramento)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'educacional-backend', timestamp: new Date().toISOString() });
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const s3 = getS3Client();
  const bucket = process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'matricula-documentos';

  if (s3) {
    try {
      const fileKey = `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(req.file.originalname)}`;
      const fileBuffer = fs.readFileSync(req.file.path);

      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fileKey,
          Body: fileBuffer,
          ContentType: req.file.mimetype,
        })
      );

      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL || (process.env.S3_ENDPOINT ? `${process.env.S3_ENDPOINT}/${bucket}` : '/uploads');
      const fileUrl = `${publicBaseUrl.replace(/\/$/, '')}/${fileKey}`;

      return res.json({
        url: fileUrl,
        filename: req.file.originalname
      });
    } catch (s3Err) {
      console.error('[S3/MinIO Upload Error, defaulting to local static storage]', s3Err);
    }
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    url: fileUrl,
    filename: req.file.originalname
  });
});

// List schools filtered by modality or all
app.get('/api/schools', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const modality = req.query.modality as string;
    const schools = await dbGetSchools(modality);

    const safeSchools = schools.map((s) => {
      const { directorPasswordHash, ...rest } = s;
      return rest;
    });

    res.json(safeSchools);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao buscar escolas: ' + err.message });
  }
});

// Submit enrollment application
app.post('/api/applications', async (req, res) => {
  try {
    await dbRunHousekeeping();

    if (await dbGetEnrollmentLocked()) {
      return res.status(403).json({ error: ENROLLMENT_LOCKED_MESSAGE });
    }

    const data = req.body;

    // Valida a data de nascimento antes de qualquer cálculo/gravação:
    // evita registros com data incompatível (ex.: hoje ou no futuro), que geravam
    // idade nula/negativa e quebravam a constraint NOT NULL da coluna "age".
    const parsedBirthDate = new Date(`${data.birthDate}T00:00:00`);
    const todayAtMidnight = new Date();
    todayAtMidnight.setHours(0, 0, 0, 0);

    if (!data.birthDate || isNaN(parsedBirthDate.getTime())) {
      return res.status(400).json({
        error: 'Data de nascimento inválida ou não informada. Verifique o campo e tente novamente.'
      });
    }
    if (parsedBirthDate >= todayAtMidnight) {
      return res.status(400).json({
        error: 'Data de nascimento inválida: não pode ser hoje nem uma data futura. Corrija o dia, mês e ano informados.'
      });
    }

    // Idade sempre calculada no servidor a partir da data de nascimento validada
    // (não confiamos apenas no valor enviado pelo cliente).
    let age = todayAtMidnight.getFullYear() - parsedBirthDate.getFullYear();
    const monthDiff = todayAtMidnight.getMonth() - parsedBirthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && todayAtMidnight.getDate() < parsedBirthDate.getDate())) {
      age--;
    }
    data.age = age;

    if (data.modality === 'eja') {
      if (data.enteringGrade?.includes('Fundamental') && age < 15) {
        return res.status(400).json({
          error: `Para ingressar no EJA Ensino Fundamental é necessário ter no mínimo 15 anos completos. (Idade informada: ${age} anos)`
        });
      }
      if (data.enteringGrade?.includes('Médio') && age < 18) {
        return res.status(400).json({
          error: `Para ingressar no EJA Ensino Médio é necessário ter no mínimo 18 anos completos. (Idade informada: ${age} anos)`
        });
      }
    }

    const year = new Date().getFullYear();
    const randomHex = Math.random().toString(36).substring(2, 7).toUpperCase();
    const protocol = `SER-${year}-${randomHex}`;

    const school = await dbGetSchoolById(data.schoolId);
    const schoolName = school ? school.name : 'Escola Não Identificada';

    const newApplication = await dbCreateApplication({
      ...data,
      protocol,
      schoolName
    });

    if (data.email) {
      const subject = `Protocolo de Pré-Matrícula nº ${protocol} - Serrinha-BA`;
      const text = `Olá, ${data.studentName}!\n\nSua solicitação de pré-matrícula para ${schoolName} foi recebida com sucesso!\n\nSeu Número de Protocolo é: ${protocol}\n\nUtilize este protocolo no portal para acompanhar o status da sua solicitação.\n\nSecretaria Municipal de Educação de Serrinha-BA`;
      const html = `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #1e3a8a;">Secretaria Municipal de Educação de Serrinha-BA</h2>
          <p>Olá, <strong>${data.studentName}</strong>!</p>
          <p>Sua solicitação de pré-matrícula foi enviada com sucesso para a instituição <strong>${schoolName}</strong>.</p>
          <div style="background-color: #f3f4f6; padding: 15px; border-radius: 6px; text-align: center; margin: 20px 0;">
            <span style="font-size: 14px; color: #4b5563;">SEU NÚMERO DE PROTOCOLO:</span><br/>
            <strong style="font-size: 24px; color: #1e40af; letter-spacing: 2px;">${protocol}</strong>
          </div>
          <p style="color: #374151;">Guarde este número com cuidado! Você poderá utilizá-lo na página inicial para verificar se seu cadastro foi homologado.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 12px; color: #6b7280;">Prefeitura Municipal de Serrinha - Secretaria de Educação</p>
        </div>
      `;
      sendNotificationEmail(data.email, subject, text, html);
    }

    res.status(201).json({
      message: 'Solicitação enviada com sucesso!',
      protocol,
      application: newApplication
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao enviar solicitação: ' + err.message });
  }
});

// Protocol status check query
app.get('/api/applications/protocol/:protocol', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const protocol = req.params.protocol.trim().toUpperCase();
    const appItem = await dbGetApplicationByProtocol(protocol);

    if (!appItem) {
      return res.status(404).json({ error: 'Protocolo não encontrado. Verifique o código e tente novamente.' });
    }

    res.json({
      protocol: appItem.protocol,
      studentName: appItem.studentName,
      schoolName: appItem.schoolName,
      status: appItem.status,
      rejectionReason: appItem.rejectionReason || null,
      createdAt: appItem.createdAt,
      updatedAt: appItem.updatedAt
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao consultar protocolo: ' + err.message });
  }
});

// Director & Admin Unified Login
app.post('/api/auth/director/login', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const { username, password } = req.body;

    // 1. Check School Director first
    const school = await dbGetSchoolByUsername(username);

    if (school && bcrypt.compareSync(password, school.directorPasswordHash)) {
      return res.json({
        role: 'director',
        schoolId: school.id,
        schoolName: school.name,
        username: school.directorUsername,
        contactEmail: school.contactEmail
      });
    }

    // 2. Check Admin account if not a school director
    const admin = await dbGetAdminByUsername(username);

    if (admin && bcrypt.compareSync(password, admin.passwordHash)) {
      if (admin.status === 'pending') {
        return res.status(403).json({ error: 'Sua conta de administrador ainda está pendente de aprovação pelo Admin Master.' });
      }

      return res.json({
        role: 'admin',
        username: admin.username,
        isMaster: admin.isMaster,
        status: admin.status
      });
    }

    return res.status(401).json({ error: 'Usuário ou senha incorretos. Verifique suas credenciais.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao autenticar: ' + err.message });
  }
});

// Director Password / Login Recovery
app.post('/api/auth/director/recover-password', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const { email } = req.body;

    const school = await dbGetSchoolByEmail(email);

    if (!school) {
      return res.status(404).json({
        error: 'E-mail não encontrado nos registros de direções. Se você não cadastrou este e-mail ou não se lembra, entre em contato com a Secretaria de Educação.'
      });
    }

    const savedPassword = school.recpswrec || 'Senha não localizada. Contate a Secretaria.';

    const subject = `Recuperação de Login da Escola - ${school.name}`;
    const text = `Olá, ${school.directorName}!\n\nSeguem seus dados de acesso ao Portal da Escola:\n\nUsuário: ${school.directorUsername}\nSenha: ${savedPassword}\n\nSecretaria Municipal de Educação de Serrinha-BA`;
    const html = `
      <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #1e3a8a;">Recuperação de Acesso da Escola</h2>
        <p>Olá, <strong>${school.directorName}</strong> (<em>${school.name}</em>),</p>
        <p>Abaixo estão os dados de login cadastrados no banco de dados para acesso ao portal da sua unidade escolar:</p>
        <div style="background-color: #f3f4f6; padding: 15px; border-radius: 6px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Nome de Usuário:</strong> <code style="font-size: 15px; color: #1e40af; font-weight: bold;">${school.directorUsername}</code></p>
          <p style="margin: 5px 0;"><strong>Senha Cadastrada:</strong> <code style="font-size: 15px; color: #047857; font-weight: bold;">${savedPassword}</code></p>
        </div>
        <p style="color: #374151;">Utilize o nome de usuário e a senha cadastrados acima para efetuar seu login.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
        <p style="font-size: 12px; color: #6b7280;">Secretaria Municipal de Educação de Serrinha-BA</p>
      </div>
    `;

    await sendNotificationEmail(email, subject, text, html);

    res.json({ message: `Acesso de login e senha enviados para ${email}!` });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao recuperar senha: ' + err.message });
  }
});

// Update director contact email
app.put('/api/director/email', async (req, res) => {
  try {
    const { schoolId, email } = req.body;
    const school = await dbGetSchoolById(schoolId);

    if (!school) {
      return res.status(404).json({ error: 'Escola não encontrada.' });
    }

    if (email) {
      const existingEmail = await dbGetSchoolByEmail(email);
      if (existingEmail && existingEmail.id !== schoolId) {
        return res.status(400).json({ error: 'Este e-mail já está cadastrado para outra escola/diretor(a). Informe outro e-mail.' });
      }
    }

    await dbUpdateSchoolEmail(schoolId, email);
    school.contactEmail = email;

    res.json({ message: 'E-mail atualizado com sucesso!', school });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar e-mail: ' + err.message });
  }
});

// Director list applications for their school
app.get('/api/director/applications/:schoolId', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const schoolId = req.params.schoolId;
    const schoolApps = await dbGetApplicationsBySchool(schoolId);

    const now = new Date().getTime();
    const THREE_MONTHS = 90 * 24 * 60 * 60 * 1000;

    const filtered = schoolApps.filter((appItem) => {
      if (appItem.status === 'Rejeitado') {
        const updated = new Date(appItem.updatedAt || appItem.createdAt).getTime();
        if (now - updated > THREE_MONTHS) {
          return false;
        }
      }
      return true;
    });

    res.json(filtered);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao listar solicitações: ' + err.message });
  }
});

// Director update application status (Homologar / Rejeitar / Lista de Espera)
app.patch('/api/director/applications/:protocol', async (req, res) => {
  try {
    const protocol = req.params.protocol;
    const { status, rejectionReason } = req.body;

    const allowedStatuses = ['Cadastrado', 'Rejeitado', 'Lista de Espera'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Status inválido.' });
    }

    const appItem = await dbUpdateApplicationStatus(protocol, status, rejectionReason);
    if (!appItem) {
      return res.status(404).json({ error: 'Solicitação não encontrada.' });
    }

    if (appItem.email) {
      const subject = `Atualização de Status da Matrícula - Protocolo ${protocol}`;

      let statusText = '';
      let statusColor = '#dc2626';
      let extraMessage = '';

      if (status === 'Cadastrado') {
        statusText = 'HOMOLOGADO / CADASTRADO';
        statusColor = '#16a34a';
      } else if (status === 'Lista de Espera') {
        statusText = 'EM LISTA DE ESPERA';
        statusColor = '#d97706';
        extraMessage = 'No momento não há vagas disponíveis, porém sua solicitação está na lista de espera. Caso surja uma vaga (por desistência ou outro motivo), a escola poderá entrar em contato pelo telefone informado no cadastro.';
      } else {
        statusText = 'NÃO HOMOLOGADO';
        statusColor = '#dc2626';
      }

      const text = `Olá, ${appItem.studentName}!\n\nO status da sua solicitação de pré-matrícula (${protocol}) foi atualizado para: ${statusText}.\n${rejectionReason ? 'Motivo: ' + rejectionReason + '\n' : ''}${extraMessage ? extraMessage + '\n' : ''}\nSecretaria Municipal de Educação de Serrinha-BA`;
      const html = `
        <div style="font-family: sans-serif; padding: 20px;">
          <h3>Atualização do Pedido de Matrícula</h3>
          <p>Olá, <strong>${appItem.studentName}</strong>,</p>
          <p>Sua solicitação (Protocolo: <strong>${protocol}</strong>) foi atualizada para: <strong style="color: ${statusColor};">${statusText}</strong>.</p>
          ${rejectionReason ? `<p><strong>Motivo:</strong> ${rejectionReason}</p>` : ''}
          ${extraMessage ? `<p>${extraMessage}</p>` : ''}
          <p>Consulte o portal para mais detalhes.</p>
        </div>
      `;
      sendNotificationEmail(appItem.email, subject, text, html);
    }

    res.json({ message: 'Status atualizado com sucesso!', application: appItem });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar status: ' + err.message });
  }
});

// Hidden Admin Registration route (/adminaccess)
app.post('/api/admin/register', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    const existing = await dbGetAdminByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Nome de usuário já cadastrado.' });
    }

    const existingEmail = await dbGetAdminByEmail(email);
    if (existingEmail) {
      return res.status(400).json({ error: 'Este e-mail já está cadastrado para outra conta de administrador. Informe outro e-mail.' });
    }

    const allAdmins = await dbGetAllAdmins();
    const isFirstAdmin = allAdmins.length === 0;
    const passwordHash = bcrypt.hashSync(password, 10);

    const newAdmin = await dbCreateAdmin({
      id: `adm-${Date.now()}`,
      username: username.trim(),
      email: email.trim(),
      passwordHash,
      recpswrec: password,
      isMaster: isFirstAdmin,
      status: isFirstAdmin ? 'active' : 'pending'
    });

    if (isFirstAdmin) {
      return res.status(201).json({
        message: 'Admin Master cadastrado e ativado com sucesso!',
        admin: { id: newAdmin.id, username: newAdmin.username, isMaster: true, status: 'active' }
      });
    } else {
      return res.status(201).json({
        message: 'Solicitação de cadastro enviada! Seu cadastro requer aprovação do Admin Master.',
        admin: { id: newAdmin.id, username: newAdmin.username, isMaster: false, status: 'pending' }
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Erro no cadastro de admin: ' + err.message });
  }
});

// Admin Login
app.post('/api/auth/admin/login', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const { username, password } = req.body;

    const admin = await dbGetAdminByUsername(username);

    if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
      return res.status(401).json({ error: 'Usuário ou senha de administrador incorretos.' });
    }

    if (admin.status === 'pending') {
      return res.status(403).json({ error: 'Sua conta de administrador ainda está pendente de aprovação pelo Admin Master.' });
    }

    if (admin.status === 'rejected') {
      return res.status(403).json({ error: 'Sua solicitação de administrador foi recusada pelo Admin Master.' });
    }

    res.json({
      role: admin.isMaster ? 'master_admin' : 'admin',
      username: admin.username,
      email: admin.email,
      isMaster: admin.isMaster
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro no login de admin: ' + err.message });
  }
});

// Admin Login & Password Recovery
app.post('/api/auth/admin/recover-password', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Informe o e-mail cadastrado do administrador.' });
    }

    const admin = await dbGetAdminByEmail(email);

    if (!admin) {
      return res.status(404).json({
        error: 'E-mail não encontrado nos registros de administradores do sistema.'
      });
    }

    if (admin.status === 'pending') {
      return res.status(403).json({
        error: 'Sua conta de administrador ainda está pendente de aprovação pelo Admin Master.'
      });
    }

    const savedPassword = admin.recpswrec || 'Senha não localizada. Entre em contato com o Admin Master.';

    const subject = `Recuperação de Login de Administrador - Serrinha-BA`;
    const text = `Olá, ${admin.username}!\n\nSeguem seus dados de acesso ao Painel Administrativo (/adminaccess):\n\nUsuário: ${admin.username}\nSenha: ${savedPassword}\n\nAcesse /adminaccess e utilize estes dados para entrar no painel.\n\nSecretaria Municipal de Educação de Serrinha-BA`;
    const html = `
      <div style="font-family: sans-serif; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
        <h2 style="color: #1e3a8a;">Recuperação de Acesso Administrativo (/adminaccess)</h2>
        <p>Olá, <strong>${admin.username}</strong>!</p>
        <p>Abaixo estão seus dados de login cadastrados no banco de dados para acesso ao Painel Geral de Administração do sistema de matrículas:</p>
        <div style="background-color: #f3f4f6; padding: 15px; border-radius: 6px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>Nome de Usuário:</strong> <code style="font-size: 15px; color: #1e40af; font-weight: bold;">${admin.username}</code></p>
          <p style="margin: 5px 0;"><strong>Senha Cadastrada:</strong> <code style="font-size: 15px; color: #047857; font-weight: bold;">${savedPassword}</code></p>
        </div>
        <p style="color: #374151;">Utilize o nome de usuário e a senha cadastrados acima para efetuar seu login em /adminaccess.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
        <p style="font-size: 12px; color: #6b7280;">Secretaria Municipal de Educação de Serrinha-BA</p>
      </div>
    `;

    await sendNotificationEmail(admin.email, subject, text, html);

    res.json({ message: `Dados de login e senha cadastrados enviados com sucesso para ${admin.email}!` });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao recuperar senha de admin: ' + err.message });
  }
});

// Get pending admin registration requests (Master Admin only)
app.get('/api/admin/pending', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const pending = await dbGetPendingAdmins();
    const safePending = pending.map(({ passwordHash, ...rest }) => rest);
    res.json(safePending);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao listar admins pendentes: ' + err.message });
  }
});

// Approve or Reject pending admin (Master Admin only)
app.post('/api/admin/pending/:id/decide', async (req, res) => {
  try {
    const adminId = req.params.id;
    const { action } = req.body; // 'approve' | 'reject'

    if (action === 'approve') {
      await dbUpdateAdminStatus(adminId, 'active');
    } else {
      await dbDeleteAdmin(adminId);
    }

    res.json({ message: action === 'approve' ? 'Administrador aprovado!' : 'Solicitação rejeitada e removida do sistema.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao processar solicitação de admin: ' + err.message });
  }
});

// Register new school (Admins)
app.post('/api/admin/schools', async (req, res) => {
  try {
    const { name, modalities, directorUsername, directorPassword, contactPhone, contactEmail, address, directorName } = req.body;

    if (!name || !modalities || !directorUsername || !directorPassword) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios da escola.' });
    }

    const existing = await dbGetSchoolByUsername(directorUsername);
    if (existing) {
      return res.status(400).json({ error: 'Nome de usuário de diretor já em uso.' });
    }

    if (contactEmail) {
      const existingEmail = await dbGetSchoolByEmail(contactEmail);
      if (existingEmail) {
        return res.status(400).json({ error: 'Este e-mail já está cadastrado para outra escola/diretor(a). Informe outro e-mail.' });
      }
    }

    const schoolId = `sch-${Date.now()}`;
    const directorPasswordHash = bcrypt.hashSync(directorPassword, 10);

    await dbCreateSchool({
      id: schoolId,
      name,
      modalities,
      directorUsername: directorUsername.trim(),
      directorPasswordHash,
      recpswrec: directorPassword,
      contactPhone: contactPhone || '',
      contactEmail: contactEmail || '',
      address: address || '',
      directorName: directorName || 'Diretor(a)'
    });

    res.status(201).json({ message: 'Escola cadastrada com sucesso!' });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao cadastrar escola: ' + err.message });
  }
});

// Bulk school import (admin uploads a JSON file with an array of schools)
app.post('/api/admin/schools/bulk', async (req, res) => {
  try {
    const { schools } = req.body;

    if (!Array.isArray(schools) || schools.length === 0) {
      return res.status(400).json({ error: 'Envie um array "schools" com pelo menos uma escola.' });
    }
    if (schools.length > 200) {
      return res.status(400).json({ error: 'Limite de 200 escolas por importação. Divida o arquivo em lotes menores.' });
    }

    const results: { index: number; name: string; status: 'created' | 'error'; error?: string }[] = [];

    // Evita duplicar usuário/e-mail dentro do próprio arquivo (além da checagem contra o banco)
    const seenUsernames = new Set<string>();
    const seenEmails = new Set<string>();

    for (let i = 0; i < schools.length; i++) {
      const raw = schools[i] || {};

      // Aceita tanto os nomes de coluna do banco (snake_case) quanto os nomes usados pela API (camelCase)
      const name = raw.name || raw.school_name;
      const modalities = raw.modalities;
      const directorUsername = String(raw.directorUsername || raw.director_username || '').trim();
      const directorPasswordPlain = raw.directorPassword || raw.director_password;
      const directorPasswordHashInput = raw.directorPasswordHash || raw.director_password_hash;
      const contactPhone = raw.contactPhone || raw.contact_phone || '';
      const contactEmail = String(raw.contactEmail || raw.contact_email || '').trim();
      const address = raw.address || '';
      const directorName = raw.directorName || raw.director_name || 'Diretor(a)';

      try {
        if (!name || !Array.isArray(modalities) || modalities.length === 0 || !directorUsername || (!directorPasswordPlain && !directorPasswordHashInput)) {
          throw new Error('Campos obrigatórios ausentes (name, modalities, director_username, director_password).');
        }

        const invalidModalities = modalities.filter((m: string) => !ALLOWED_MODALITIES.includes(m));
        if (invalidModalities.length > 0) {
          throw new Error(`Modalidade(s) inválida(s): ${invalidModalities.join(', ')}. Válidas: ${ALLOWED_MODALITIES.join(', ')}.`);
        }

        const usernameKey = directorUsername.toLowerCase();
        if (seenUsernames.has(usernameKey)) {
          throw new Error('Nome de usuário de diretor duplicado dentro do próprio arquivo.');
        }
        const existingUsername = await dbGetSchoolByUsername(directorUsername);
        if (existingUsername) {
          throw new Error('Nome de usuário de diretor já em uso no sistema.');
        }

        if (contactEmail) {
          const emailKey = contactEmail.toLowerCase();
          if (seenEmails.has(emailKey)) {
            throw new Error('E-mail duplicado dentro do próprio arquivo.');
          }
          const existingEmail = await dbGetSchoolByEmail(contactEmail);
          if (existingEmail) {
            throw new Error('E-mail já cadastrado para outra escola/diretor(a).');
          }
        }

        const schoolId = raw.id || `sch-${Date.now()}-${i}`;
        const directorPasswordHash = directorPasswordHashInput || bcrypt.hashSync(String(directorPasswordPlain), 10);

        await dbCreateSchool({
          id: schoolId,
          name,
          modalities,
          directorUsername,
          directorPasswordHash,
          // Só guardamos a senha em texto puro (para recuperação por e-mail) quando ela foi enviada em texto puro.
          // Se só veio o hash pronto, não há como recuperar o valor original, então recpswrec fica vazio.
          recpswrec: directorPasswordPlain ? String(directorPasswordPlain) : '',
          contactPhone,
          contactEmail,
          address,
          directorName
        });

        seenUsernames.add(usernameKey);
        if (contactEmail) seenEmails.add(contactEmail.toLowerCase());

        results.push({ index: i, name, status: 'created' });
      } catch (itemErr: any) {
        results.push({ index: i, name: name || `(item ${i + 1})`, status: 'error', error: itemErr.message });
      }
    }

    const createdCount = results.filter((r) => r.status === 'created').length;
    const errorCount = results.length - createdCount;

    res.status(createdCount === 0 ? 400 : 200).json({
      message: `${createdCount} escola(s) cadastrada(s) com sucesso${errorCount > 0 ? `, ${errorCount} com erro (veja detalhes)` : ''}.`,
      created: createdCount,
      failed: errorCount,
      results
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao importar escolas: ' + err.message });
  }
});

// Delete school (Admins)
app.delete('/api/admin/schools/:id', async (req, res) => {
  try {
    const schoolId = req.params.id;
    await dbDeleteSchool(schoolId);
    res.json({ message: 'Escola removida do sistema.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao deletar escola: ' + err.message });
  }
});

// Global Applications overview for Admins
app.get('/api/admin/applications', async (req, res) => {
  try {
    await dbRunHousekeeping();
    const apps = await dbGetAllApplications();
    res.json(apps);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao carregar solicitações gerais: ' + err.message });
  }
});

// Get System Announcement / Notice
app.get('/api/announcement', async (req, res) => {
  try {
    const data = await dbGetAnnouncement();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao obter comunicado: ' + err.message });
  }
});

// Public: consulta se o período de matrículas está encerrado (usado pela home antes de abrir o formulário)
app.get('/api/enrollment-status', async (req, res) => {
  try {
    const locked = await dbGetEnrollmentLocked();
    res.json({ locked, message: locked ? ENROLLMENT_LOCKED_MESSAGE : null });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao obter status das matrículas: ' + err.message });
  }
});

// Admin: liga/desliga o bloqueio geral de matrículas para todas as escolas
app.put('/api/admin/enrollment-lock', async (req, res) => {
  try {
    const { locked } = req.body;
    if (typeof locked !== 'boolean') {
      return res.status(400).json({ error: 'Valor inválido para "locked".' });
    }
    const updated = await dbSetEnrollmentLocked(locked);
    res.json({ locked: updated, message: updated ? ENROLLMENT_LOCKED_MESSAGE : null });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar status das matrículas: ' + err.message });
  }
});

// Update System Announcement (Admins)
app.put('/api/admin/announcement', async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Título e texto do comunicado são obrigatórios.' });
    }
    if (content.length > 300) {
      return res.status(400).json({ error: 'O texto do comunicado excede o limite de 300 caracteres.' });
    }
    const updated = await dbSaveAnnouncement(title.trim(), content.trim());
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao salvar comunicado: ' + err.message });
  }
});

async function initDbSchema() {
  try {
    await pool.query(`
      ALTER TABLE schools ADD COLUMN IF NOT EXISTS recpswrec VARCHAR(255);
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS recpswrec VARCHAR(255);
    `);
    await pool.query(`
      UPDATE schools SET recpswrec = 'diretor123' WHERE recpswrec IS NULL OR recpswrec = '';
    `);
    console.log('[DB Schema Init] Columns recpswrec checked/migrated.');
  } catch (err) {
    console.warn('[DB Schema Init Warning]', err);
  }
}

// Fallback para rotas de API não encontradas
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Rota de API não encontrada.' });
});

// Start express server (API pura - o frontend é servido por outro serviço/imagem)
async function start() {
  await initDbSchema();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`API rodando em http://0.0.0.0:${PORT}`);
  });
}

start();

