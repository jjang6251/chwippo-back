import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { JobPostingController } from './job-posting.controller';
import { JobPostingService } from './job-posting.service';
import { ParseJobPostingDto, UpdateJobPostingDto } from './dto/job-posting.dto';

/** 컨트롤러는 CurrentUser.id 로 서비스에 위임 (IDOR 는 서비스에서 WHERE userId 검증) */
describe('JobPostingController', () => {
  let controller: JobPostingController;
  let service: jest.Mocked<JobPostingService>;

  const user = { id: 'user-1', role: 'user' };
  const APP_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    service = mock<JobPostingService>();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [JobPostingController],
      providers: [{ provide: JobPostingService, useValue: service }],
    }).compile();
    controller = module.get(JobPostingController);
  });

  it('POST parse → service.parse(userId, id, dto)', () => {
    const dto = Object.assign(new ParseJobPostingDto(), { rawText: 'x' });
    void controller.parse(user, APP_ID, dto);
    expect(service.parse).toHaveBeenCalledWith(user.id, APP_ID, dto);
  });

  it('PATCH → service.update(userId, id, dto)', () => {
    const dto: UpdateJobPostingDto = { preferred: ['AWS'] };
    void controller.update(user, APP_ID, dto);
    expect(service.update).toHaveBeenCalledWith(user.id, APP_ID, dto);
  });

  it('DELETE → service.remove(userId, id)', () => {
    void controller.remove(user, APP_ID);
    expect(service.remove).toHaveBeenCalledWith(user.id, APP_ID);
  });
});
