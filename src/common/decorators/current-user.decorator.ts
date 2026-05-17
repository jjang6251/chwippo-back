import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * LRR P2T1 PR T (M-30): JwtStrategy.validate()가 반환하는 shape과 1:1 일치.
 * 컨트롤러는 이 type을 import해서 일관되게 사용 (자체 inline type 정의 불요).
 */
export interface CurrentUserPayload {
  id: string;
  nickname: string;
  email: string | null;
  role: string;
}

interface AuthedRequest extends Request {
  user?: CurrentUserPayload;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentUserPayload | undefined => {
    const request = ctx.switchToHttp().getRequest<AuthedRequest>();
    return request.user;
  },
);
