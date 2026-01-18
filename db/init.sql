CREATE DATABASE IF NOT EXISTS upv_chat
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_uca1400_ai_ci;

USE upv_chat;

-- USUARIOS
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(50)  NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB;

-- (Opcional, recomendado para futuro) dispositivos/sesiones
CREATE TABLE IF NOT EXISTS user_devices (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED    NOT NULL,
  label      VARCHAR(80)     NULL,
  last_seen  TIMESTAMP       NULL DEFAULT NULL,
  created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_devices_user (user_id),
  CONSTRAINT fk_devices_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- CONVERSACIONES (sirve para 1 a 1 y grupos)
CREATE TABLE IF NOT EXISTS conversations (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type         ENUM('dm','group') NOT NULL DEFAULT 'dm',
  title        VARCHAR(120) NULL,
  created_by   INT UNSIGNED NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_conv_created_at (created_at),
  KEY idx_conv_created_by (created_by),
  CONSTRAINT fk_conv_created_by
    FOREIGN KEY (created_by) REFERENCES users(id)
    ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- PARTICIPANTES (tabla puente: N usuarios por conversación)
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id BIGINT UNSIGNED NOT NULL,
  user_id         INT UNSIGNED    NOT NULL,
  role            ENUM('member','admin') NOT NULL DEFAULT 'member',
  joined_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at         TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (conversation_id, user_id),
  KEY idx_members_user (user_id),
  CONSTRAINT fk_members_conversation
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_members_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- MENSAJES (contenido principal)
CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_user_id  INT UNSIGNED    NOT NULL,
  body            TEXT            NOT NULL,
  msg_type        ENUM('text','system') NOT NULL DEFAULT 'text',
  created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_msg_conv_time (conversation_id, created_at),
  KEY idx_msg_sender_time (sender_user_id, created_at),
  CONSTRAINT fk_msg_conversation
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_msg_sender
    FOREIGN KEY (sender_user_id) REFERENCES users(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB;

-- ESTADO DE ENTREGA/LECTURA POR USUARIO (doble check / read receipts)
--  - delivered_at: el receptor lo recibió en cliente
--  - read_at: el receptor lo abrió/leyó (extensión futura)
DROP TABLE IF EXISTS message_receipts;

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id   BIGINT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED    NOT NULL,
  device_id    BIGINT UNSIGNED NULL,

  delivered_at TIMESTAMP NULL DEFAULT NULL,
  read_at      TIMESTAMP NULL DEFAULT NULL,

  PRIMARY KEY (message_id, user_id),
  KEY idx_receipts_user (user_id, delivered_at, read_at),
  KEY idx_receipts_device (device_id),

  CONSTRAINT fk_receipts_message
    FOREIGN KEY (message_id) REFERENCES messages(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,

  CONSTRAINT fk_receipts_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,

  CONSTRAINT fk_receipts_device
    FOREIGN KEY (device_id) REFERENCES user_devices(id)
    ON DELETE SET NULL ON UPDATE RESTRICT
) ENGINE=InnoDB;


-- BLOQUEOS (extensión: denegar mensajes)
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id INT UNSIGNED NOT NULL,
  blocked_user_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CONSTRAINT fk_blocks_blocker
    FOREIGN KEY (blocker_user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_blocks_blocked
    FOREIGN KEY (blocked_user_id) REFERENCES users(id)
    ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB;