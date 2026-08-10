-- Database Schema for Sistema de Cadastro Escolar (Serrinha-BA)

CREATE TABLE IF NOT EXISTS schools (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    modalities TEXT[] NOT NULL,
    director_username VARCHAR(100) UNIQUE NOT NULL,
    director_password_hash VARCHAR(255) NOT NULL,
    recpswrec VARCHAR(255),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),
    address VARCHAR(255),
    director_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS applications (
    protocol VARCHAR(50) PRIMARY KEY,
    modality VARCHAR(50) NOT NULL,
    school_id VARCHAR(64) REFERENCES schools(id) ON DELETE CASCADE,
    school_name VARCHAR(255) NOT NULL,
    student_name VARCHAR(255) NOT NULL,
    last_grade_completed VARCHAR(100) NOT NULL,
    entering_grade VARCHAR(100) NOT NULL,
    birth_date DATE NOT NULL,
    age INT NOT NULL,
    gender VARCHAR(30) NOT NULL,
    race_color VARCHAR(30) NOT NULL,
    mother_name VARCHAR(255) NOT NULL,
    father_name VARCHAR(255),
    mother_cpf VARCHAR(20),
    father_cpf VARCHAR(20),
    rg_document_url TEXT,
    rg_document_name TEXT,
    use_responsible_rg BOOLEAN DEFAULT FALSE,
    transcript_url TEXT,
    transcript_name TEXT,
    phone VARCHAR(30) NOT NULL,
    email VARCHAR(255) NOT NULL,
    street VARCHAR(255) NOT NULL,
    number VARCHAR(50) NOT NULL,
    neighborhood VARCHAR(100) NOT NULL,
    city VARCHAR(100) DEFAULT 'Serrinha-BA',
    income VARCHAR(100),
    bolsa_familia BOOLEAN DEFAULT FALSE,
    status VARCHAR(30) DEFAULT 'Pendente',
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admins (
    id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    recpswrec VARCHAR(255),
    is_master BOOLEAN DEFAULT FALSE,
    status VARCHAR(30) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed Initial Municipal Schools
INSERT INTO schools (id, name, modalities, director_username, director_password_hash, contact_phone, contact_email, address, director_name)
VALUES
(
    'sch-1',
    'Escola Municipal Ivone Gonçalves',
    ARRAY['educacao-infantil', 'ensino-fundamental'],
    'dir.ivone',
    '$2a$10$r9.GgM2kS58mS62p40x4/.5g6o.XN8S1ZkP1A/zZ5v9N9q6K9W6vG', -- diretor123
    '(75) 98822-1010',
    'escola.ivone.goncalves@serrinha.ba.gov.br',
    'Rua A, s/n - Bairro Ginásio, Serrinha-BA',
    'Profa. Ana Maria Silva'
),
(
    'sch-2',
    'Colégio Municipal Rubem Nogueira',
    ARRAY['ensino-fundamental', 'ensino-medio', 'eja'],
    'dir.rubem',
    '$2a$10$r9.GgM2kS58mS62p40x4/.5g6o.XN8S1ZkP1A/zZ5v9N9q6K9W6vG', -- diretor123
    '(75) 98833-2020',
    'colegio.rubem.nogueira@serrinha.ba.gov.br',
    'Praça Morena Bela, 120 - Centro, Serrinha-BA',
    'Prof. Carlos Oliveira'
),
(
    'sch-3',
    'Centro de Educação Infantil Maria Menina',
    ARRAY['educacao-infantil'],
    'dir.mariamenina',
    '$2a$10$r9.GgM2kS58mS62p40x4/.5g6o.XN8S1ZkP1A/zZ5v9N9q6K9W6vG', -- diretor123
    '(75) 98844-3030',
    'creche.mariamenina@serrinha.ba.gov.br',
    'Rua Bela Vista, 45 - Cidade Nova, Serrinha-BA',
    'Profa. Lucia Santos'
),
(
    'sch-4',
    'Escola Municipal Leôncio Horácio',
    ARRAY['ensino-fundamental', 'eja'],
    'dir.leoncio',
    '$2a$10$r9.GgM2kS58mS62p40x4/.5g6o.XN8S1ZkP1A/zZ5v9N9q6K9W6vG', -- diretor123
    '(75) 98855-4040',
    'escola.leoncio@serrinha.ba.gov.br',
    'Av. Araci, 300 - Bairro Novo Horizonte, Serrinha-BA',
    'Prof. Roberto Souza'
)
ON CONFLICT (id) DO NOTHING;

