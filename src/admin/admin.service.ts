import { Injectable } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { InquiriesService } from '../inquiries/inquiries.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly usersService: UsersService,
    private readonly inquiriesService: InquiriesService,
  ) {}

  async getStats() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);

    const [totalUsers, newUsersMonth, newUsersWeek, pendingInquiries] = await Promise.all([
      this.usersService.countAll(),
      this.usersService.countByDate(startOfMonth),
      this.usersService.countByDate(startOfWeek),
      this.inquiriesService.countPending(),
    ]);

    return { totalUsers, newUsersMonth, newUsersWeek, pendingInquiries };
  }
}
