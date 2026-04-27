import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1777315557617 implements MigrationInterface {
    name = 'Init1777315557617'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "kakao_id" character varying NOT NULL, "nickname" character varying NOT NULL, "email" character varying, "refresh_token" character varying, "role" character varying NOT NULL DEFAULT 'user', "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_6f828bb866308ab509c0e6fd873" UNIQUE ("kakao_id"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "todos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying NOT NULL, "content" text NOT NULL, "date" date NOT NULL, "is_done" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ca8cafd59ca6faaf67995344225" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "user_profiles" ("user_id" character varying NOT NULL, "name" character varying, "name_hanja" character varying, "gender" character varying, "birthdate" date, "phone" character varying, "email_personal" character varying, "military_branch" character varying, "military_type" character varying, "military_start" date, "military_end" date, "military_unit" character varying, "goal_toeic" integer, "goal_certs" text, "goal_other" text, CONSTRAINT "PK_6ca9503d77ae39b4b5a6cc3ba88" PRIMARY KEY ("user_id"))`);
        await queryRunner.query(`CREATE TABLE "myinfo_language_certs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying NOT NULL, "cert_type" character varying NOT NULL, "score_grade" character varying, "issuer" character varying, "cert_number" character varying, "acquired_at" date, "file_url" character varying, CONSTRAINT "PK_1f60fd5e6b5a78ff3d5a27223e2" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "myinfo_coverletter" ("user_id" character varying NOT NULL, "personality_strength" text, "personality_weakness" text, "background" text, "job_competency" text, "aspiration" text, "own_strength" text, "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9082c1cd0f7851c6ba11fa557d1" PRIMARY KEY ("user_id"))`);
        await queryRunner.query(`CREATE TABLE "myinfo_experiences" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying NOT NULL, "activity_name" character varying NOT NULL, "org" character varying, "start_at" date, "end_at" date, "content" text, CONSTRAINT "PK_62b2cc4bf0981fdccaea9059451" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "myinfo_coverletter_custom" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying NOT NULL, "label" character varying NOT NULL, "content" text, "order_index" integer NOT NULL, CONSTRAINT "PK_a95015ebc1f795100d9a9cb1e65" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "myinfo_certs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying NOT NULL, "name" character varying NOT NULL, "issuer" character varying, "cert_number" character varying, "acquired_at" date, "file_url" character varying, CONSTRAINT "PK_462f98be9071badd06058a8932f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "myinfo_awards" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying NOT NULL, "contest_name" character varying NOT NULL, "award_name" character varying, "org" character varying, "awarded_at" date, "content" character varying(200), "file_url" character varying, CONSTRAINT "PK_a98efc29d76f7eaa9aba55f3cac" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "inquiries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying, "category" character varying NOT NULL, "title" character varying NOT NULL, "content" text NOT NULL, "status" character varying NOT NULL DEFAULT 'PENDING', "admin_reply" text, "replied_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_ceacaa439988b25eb9459e694d9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "applications" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" character varying NOT NULL, "company_name" character varying NOT NULL, "job_title" character varying, "job_category" character varying, "status" character varying NOT NULL DEFAULT 'IN_PROGRESS', "deadline" date, "job_url" character varying, "memo" text, "current_step_index" integer NOT NULL DEFAULT '0', "needs_detail" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP, CONSTRAINT "PK_938c0a27255637bde919591888f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "application_steps" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "application_id" character varying NOT NULL, "order_index" integer NOT NULL, "name" character varying NOT NULL, "scheduled_date" TIMESTAMP WITH TIME ZONE, "location" character varying, CONSTRAINT "PK_f12ba2ca4ab9b85b5292901a3fe" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "application_steps"`);
        await queryRunner.query(`DROP TABLE "applications"`);
        await queryRunner.query(`DROP TABLE "inquiries"`);
        await queryRunner.query(`DROP TABLE "myinfo_awards"`);
        await queryRunner.query(`DROP TABLE "myinfo_certs"`);
        await queryRunner.query(`DROP TABLE "myinfo_coverletter_custom"`);
        await queryRunner.query(`DROP TABLE "myinfo_experiences"`);
        await queryRunner.query(`DROP TABLE "myinfo_coverletter"`);
        await queryRunner.query(`DROP TABLE "myinfo_language_certs"`);
        await queryRunner.query(`DROP TABLE "user_profiles"`);
        await queryRunner.query(`DROP TABLE "todos"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
