import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
    const filePath = path.join(process.cwd(), '../recordings/recording.wav');

    if (!fs.existsSync(filePath)) {
        return NextResponse.json({ error: 'Audio file not found' }, { status: 404 });
    }

    const fileBuffer = fs.readFileSync(filePath);

    return new NextResponse(fileBuffer, {
        headers: {
            'Content-Type': 'audio/wav',
            'Content-Length': fileBuffer.length.toString(),
        },
    });
}
