import DashboardLayout from "@/components/DashboardLayout";
import VideoUpload from "@/components/VideoUpload";
import { Video as VideoIcon, CheckCircle } from "lucide-react";

const recentVideos = [
  { id: 1, player: "Carlos Mendoza", type: "Sprint 40m", date: "2026-02-10", status: "Analizado" },
  { id: 2, player: "Luis Hernández", type: "Salto", date: "2026-02-09", status: "Analizado" },
  { id: 3, player: "Diego Ramírez", type: "Sprint 40m", date: "2026-02-09", status: "Analizado" },
  { id: 4, player: "Carlos Mendoza", type: "Salto", date: "2026-02-08", status: "Analizado" },
  { id: 5, player: "Andrés Torres", type: "Sprint 40m", date: "2026-02-08", status: "Analizado" },
];

const Videos = () => {
  return (
    <DashboardLayout>
      <div className="mb-8">
        <h1 className="font-display text-3xl font-bold text-foreground">Videos</h1>
        <p className="text-muted-foreground mt-1">Sube y analiza videos de rendimiento</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <VideoUpload />

        <div className="rounded-xl border border-border bg-card p-6 card-elevated">
          <h3 className="font-display font-bold text-lg text-foreground mb-4">Videos Recientes</h3>
          <div className="space-y-3">
            {recentVideos.map((video) => (
              <div
                key={video.id}
                className="flex items-center gap-4 rounded-lg bg-surface p-4 transition-all hover:border-primary/20 border border-transparent"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <VideoIcon className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{video.player}</p>
                  <p className="text-xs text-muted-foreground">{video.type} · {video.date}</p>
                </div>
                <div className="flex items-center gap-1.5 text-primary">
                  <CheckCircle className="h-4 w-4" />
                  <span className="text-xs font-medium">{video.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
};

export default Videos;
